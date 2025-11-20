const config = {
  input: './src/index.ts',
  server: {
    port: 8080,
  },
  polyfills: {
    buffer: true,
  },
  stats: {
    buffer: false,
    builtIns: {
      // This snap will use Node.js built-ins.
      ignore: ['fs'],
    },
  },
};

module.exports = config;
