// Resolves once the line has left the process rather than once it has been queued. `console.log`
// does the latter, so a `process.exit` after one truncates whatever is still in a pipe's buffer.
export function writeLine(stream, line) {
  return new Promise((written, failed) => {
    stream.write(`${line}\n`, (error) => (error ? failed(error) : written()));
  });
}
