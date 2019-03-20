const _ = require('lodash');
const ora = require('ora');

const readFilePerLine = require('../../utils/read-file-per-line');
const statFileLinesToDataLines = require('../../utils/stat-file-lines-to-data-lines');

const loadPCA = async (folder, pcaFiles) => {
  const spinner = ora().start('Loading PCA analysis');
  spinner.time = Date.now();

  const output = {
    step: 0,
    y: new Map(),
  };

  const eigenvaluesFile = pcaFiles.find(filename =>
    filename.includes('eigenval'),
  );
  const eigenvalueGenerator = statFileLinesToDataLines(
    readFilePerLine(folder + eigenvaluesFile),
  );
  let maxIndex = 0;
  for await (const [index, eigenvalue] of eigenvalueGenerator) {
    output.y.set(`component-${index}`, { eigenvalue });
    maxIndex = index;
  }

  const projectionFile = pcaFiles.find(filename => filename.includes('proj'));
  const projectionGenerator = statFileLinesToDataLines(
    readFilePerLine(folder + projectionFile),
    { emitCommentSymbol: true },
  );
  let currentComponent = 0;
  let maxComponent = 0;
  let startedProcessing = true;
  let currentData;
  // for await (const [index, value] of projectionGenerator) {
  for await (const yielded of projectionGenerator) {
    if (yielded === statFileLinesToDataLines.COMMENT_SYMBOL) {
      if (startedProcessing) {
        currentComponent++;
        startedProcessing = false;
        spinner.text = `Loading PCA analysis (projection ${currentComponent} out of ${maxIndex} possible)`;
      }
      continue;
    }
    const [index, value] = yielded;
    if (!startedProcessing) {
      startedProcessing = true;
      currentData = output.y.get(`component-${currentComponent}`).data = [];
      maxComponent = currentComponent;
    }
    if (!output.step) output.step = index;
    currentData.push(value);
  }

  output.y = _.fromPairs(Array.from(output.y.entries()));

  spinner.succeed(
    `Loaded PCA analysis, ${maxIndex} components, ${maxComponent} projections (${Math.round(
      (Date.now() - spinner.time) / 1000,
    )}s)`,
  );

  return output;
};

module.exports = loadPCA;