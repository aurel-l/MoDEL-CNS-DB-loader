const fs = require('fs');
const devNull = require('dev-null');
const chalk = require('chalk');

const loadFile = (folder, filename, bucket, dryRun) =>
  new Promise((resolve, reject) => {
    if (!(folder && filename)) {
      return reject(new Error('Need to pass a folder and a filename'));
    }
    try {
      const readStream = fs.createReadStream(folder + filename);
      const writeStream = dryRun
        ? devNull()
        : bucket.openUploadStream(filename);
      readStream.on('error', reject);
      writeStream.on('finish', resolve);
      readStream.pipe(writeStream);
    } catch (error) {
      console.error(chalk.bgRed(error));
      reject(error);
    }
  });

module.exports = loadFile;
