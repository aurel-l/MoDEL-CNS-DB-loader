const fetch = require('node-fetch');
const mongodb = require('mongodb');
const chalk = require('chalk');
const ora = require('ora');

const categorizeFilesInFolder = require('./categorize-files-in-folder');
const loadTrajectory = require('./load-trajectory');
const loadMetadata = require('./load-metadata');
const loadFile = require('./load-file');
const loadAnalysis = require('./load-analysis');

const loadFolder = async (folder, bucket, files, gromacsPath, dryRun) => {
  // find files
  const {
    rawFiles,
    trajectoryFile,
    analysisFiles,
  } = await categorizeFilesInFolder(folder);

  // process files
  const metadata = await loadMetadata(folder);

  const trajectoryFileDescriptor =
    trajectoryFile &&
    (await loadTrajectory(
      folder,
      trajectoryFile,
      bucket,
      files,
      gromacsPath,
      dryRun,
    ));

  if (trajectoryFileDescriptor.metadata) {
    metadata.frameCount = trajectoryFileDescriptor.metadata.frames;
    metadata.atomCount = trajectoryFileDescriptor.metadata.atoms;
  }

  const storedFiles = [];
  let spinner = ora().start(
    `Loading ${rawFiles.length} file${rawFiles.length > 1 ? 's' : ''}`,
  );
  spinner.time = Date.now();
  for (const [index, filename] of rawFiles.entries()) {
    spinner.text = `Loading file ${index + 1} out of ${
      rawFiles.length
    } (${filename})`;
    storedFiles.push(await loadFile(folder, filename, bucket, dryRun));
  }
  spinner.succeed(
    `Loaded ${rawFiles.length} file${
      rawFiles.length > 1 ? 's' : ''
    } (${Math.round((Date.now() - spinner.time) / 1000)}s)`,
  );
  const analyses = {};
  spinner = ora().start(
    `Loading ${analysisFiles.length} analys${
      analysisFiles.length > 1 ? 'es' : 'is'
    }`,
  );
  spinner.time = Date.now();
  for (const [index, filename] of analysisFiles.entries()) {
    spinner.text = `Loading analysis ${index + 1} out of ${
      rawFiles.length
    } (${filename})`;
    const [analysisName, analysisData] = await loadAnalysis(folder, filename);
    analyses[analysisName] = analysisData;
  }
  spinner.succeed(
    `Loaded ${analysisFiles.length} analys${
      analysisFiles.length > 1 ? 'es' : 'is'
    } (${Math.round((Date.now() - spinner.time) / 1000)}s)`,
  );
  return {
    metadata,
    files: [...storedFiles, trajectoryFileDescriptor].filter(Boolean),
    analyses,
  };
};

const loadPdbInfo = pdbID => {
  const spinner = ora().start(`Loading PDB Info for ${pdbID} from API`);
  spinner.time = Date.now();
  return pdbID
    ? fetch(`http://mmb.pcb.ub.es/api/pdb/${pdbID}/entry`)
        .then(response => response.json())
        .then(data => {
          spinner.succeed(
            `Loaded PDB Info for ${pdbID} from API (${Math.round(
              (Date.now() - spinner.time) / 1000,
            )}s)`,
          );
          return data;
        })
        .catch(error => {
          spinner.fail(error);
        })
    : undefined;
};

const getNextId = async (counters, dryRun) => {
  const result = await counters.findOneAndUpdate(
    { name: 'identifier' },
    { $inc: { count: dryRun ? 0 : 1 } },
    {
      projection: { _id: false, count: true },
      // return the new document with the new counter for the custom identifier
      returnOriginal: false,
    },
  );
  return `MCNS${`${result.value.count}`.padStart(5, '0')}`;
};

let session;

const loadFolders = async ({
  folders,
  dryRun = false,
  output,
  gromacsPath,
}) => {
  let mongoConfig;
  try {
    // mongo config file, can be json or js code
    mongoConfig = require('../../configs/mongo');
  } catch (_) {
    console.error("couldn't find mongo config file");
    return;
  }
  let client;
  let writer;
  try {
    const { server, port, db: dbName, ...config } = mongoConfig;
    client = await mongodb.MongoClient.connect(
      `mongodb://${server}:${port}`,
      config,
    );
    session = client.startSession();
    const db = client.db(dbName);
    const bucket = new mongodb.GridFSBucket(db);
    if (dryRun) {
      console.log(
        chalk.yellow('running in "dry-run" mode, won\'t affect the database'),
      );
    }
    writer = output && (await require('./output-writer')(output));
    for (const [index, folder] of folders.entries()) {
      const startTime = Date.now();
      try {
        console.log(
          chalk.blue(`processing folder ${index + 1} out of ${folders.length}`),
        );
        console.log(chalk.cyan(`== starting load of '${folder}'`));
        session.startTransaction();
        const projects = db.collection('projects');
        const pdbInfo = await loadPdbInfo(
          (folder.match(/\/(\w{4})[^/]+\/?$/i) || [])[1],
        );
        const document = {
          pdbInfo,
          ...(await loadFolder(
            folder,
            bucket,
            db.collection('fs.files'),
            gromacsPath,
            dryRun,
          )),
          // do this last, in case something fails before doesn't trigger the
          // counter increment (side-effect)
          _id: await getNextId(db.collection('counters'), dryRun),
        };
        const spinner = ora().start('Commiting to database');
        spinner.time = Date.now();
        const tasks = [
          writer && writer.writeToOutput(document),
          !dryRun && projects.insertOne(document),
        ].filter(Boolean);
        await Promise.all(tasks);
        await session.commitTransaction();
        spinner.succeed(
          `Commited to database (${Math.round(
            (Date.now() - spinner.time) / 1000,
          )}s)`,
        );
        console.log(
          chalk.cyan(
            `== finished loading '${folder}' as '${document._id}' (${Math.round(
              (Date.now() - startTime) / 1000,
            )}s)`,
          ),
        );
      } catch (error) {
        await session.abortTransaction();
        console.error(error);
        console.error(chalk.bgRed(`failed to load '${folder}'`));
      }
    }
  } catch (error) {
    console.error(error);
  } finally {
    if (session) session.endSession();
    if (client && 'close' in client) client.close();
    if (writer) await writer.closeOutput();
  }
};

// Handle pressing ctrl-c to exit script
process.on('SIGINT', () => {
  console.log(chalk.red('Caught interrupt signal'));
  if (!(session && session.inTransaction())) {
    process.exit(0);
    return;
  }
  const spinner = ora().start('Cancelling current transaction');
  spinner.time = Date.now();
  session.abortTransaction().then(
    () => {
      spinner.succeed(
        `Current transaction successfully cancelled (${Math.round(
          (Date.now() - spinner.time) / 1000,
        )}s)`,
      );
      process.exit(0);
    },
    () => {
      spinner.fail("Didn't manage to cancel current transaction");
      process.exit(1);
    },
  );
});

module.exports = loadFolders;
