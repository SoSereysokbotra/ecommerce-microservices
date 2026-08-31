const path = require('path');
const Module = require('module');

const appNodeModules = path.resolve(__dirname, 'node_modules');
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${appNodeModules}${path.delimiter}${process.env.NODE_PATH}`
  : appNodeModules;

Module._initPaths();

const appResolvePaths = [appNodeModules];
const resolveFilename = Module._resolveFilename;
const distAliases = new Map([
  ['@libs/common', path.resolve(__dirname, 'dist/libs/common/src/index.js')],
  ['@libs/shared-types', path.resolve(__dirname, 'dist/libs/shared-types/src/index.js')],
]);
const distAliasPrefixes = new Map([
  ['@libs/common/', path.resolve(__dirname, 'dist/libs/common/src')],
  ['@libs/shared-types/', path.resolve(__dirname, 'dist/libs/shared-types/src')],
]);

function resolveDistAlias(request, parent) {
  const parentFile = parent?.filename ?? '';
  const isCompiledParent = parentFile.includes(`${path.sep}dist${path.sep}`);
  if (!isCompiledParent) {
    return null;
  }

  const exactMatch = distAliases.get(request);
  if (exactMatch) {
    return exactMatch;
  }

  for (const [prefix, targetRoot] of distAliasPrefixes) {
    if (request.startsWith(prefix)) {
      const target = path.join(targetRoot, request.slice(prefix.length));
      return require.resolve(target);
    }
  }

  return null;
}

Module._resolveFilename = function (request, parent, isMain, options) {
  const distAlias = resolveDistAlias(request, parent);
  if (distAlias) {
    return distAlias;
  }

  try {
    return resolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    const isBareImport = !request.startsWith('.') && !path.isAbsolute(request);
    if (!isBareImport) {
      throw error;
    }

    try {
      return require.resolve(request, { paths: appResolvePaths });
    } catch {
      throw error;
    }
  }
};
