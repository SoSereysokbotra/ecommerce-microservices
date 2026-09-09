const fs = require('fs');
const path = require('path');
const Module = require('module');

const appNodeModules = path.resolve(__dirname, 'node_modules');
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${appNodeModules}${path.delimiter}${process.env.NODE_PATH}`
  : appNodeModules;

Module._initPaths();

const appResolvePaths = [appNodeModules];
const resolveFilename = Module._resolveFilename;

// Every workspace lib declares "main": "src/index.ts". That is correct for
// ts-node in development, but `node` cannot require TypeScript, so a compiled
// service resolving @libs/* through node_modules crashes on boot. nest build
// emits the compiled libs alongside the app under dist/libs/, and this map
// points compiled code at them instead.
//
// All four are listed even though no single service uses all of them: the file
// is byte-identical across every service, so an unused entry is simply never
// consulted. Entries whose dist output is absent fall through to normal
// resolution rather than masking the real error.
const LIB_NAMES = ['common', 'outbox', 'rabbitmq', 'shared-types'];

const distAliases = new Map(
  LIB_NAMES.map((name) => [`@libs/${name}`, path.resolve(__dirname, `dist/libs/${name}/src/index.js`)]),
);
const distAliasPrefixes = new Map(
  LIB_NAMES.map((name) => [`@libs/${name}/`, path.resolve(__dirname, `dist/libs/${name}/src`)]),
);

function resolveDistAlias(request, parent) {
  const parentFile = parent?.filename ?? '';
  const isCompiledParent = parentFile.includes(`${path.sep}dist${path.sep}`);
  if (!isCompiledParent) {
    return null;
  }

  const exactMatch = distAliases.get(request);
  if (exactMatch) {
    return fs.existsSync(exactMatch) ? exactMatch : null;
  }

  for (const [prefix, targetRoot] of distAliasPrefixes) {
    if (request.startsWith(prefix)) {
      const target = path.join(targetRoot, request.slice(prefix.length));
      try {
        return require.resolve(target);
      } catch {
        return null;
      }
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
