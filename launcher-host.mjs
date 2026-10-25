// The native launcher owns stdin. EOF means its parent disappeared.
// Reuse the server's normal SIGINT shutdown path instead of killing SQLite mid-write.
import './server.mjs';

if (!process.exitCode) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.pause();
    process.emit('SIGINT');
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', stop);
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdin.resume();
  // The control pipe must not keep Node alive when server startup fails.
  process.stdin.unref?.();
}
