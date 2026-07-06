const http = require('http');
const { spawn } = require('child_process');

const PORT = 9000;
const REPO_DIR = '/tmp/chat-bare.git';

const server = http.createServer((req, res) => {
  const pathInfo = req.url.replace(/\?.*$/, '');
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: REPO_DIR,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    REMOTE_USER: 'git',
    REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1',
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: req.headers['content-length'] || '0',
    GATEWAY_INTERFACE: 'CGI/1.1',
    REQUEST_METHOD: req.method,
    QUERY_STRING: req.url.includes('?') ? req.url.split('?')[1] : '',
    SERVER_PROTOCOL: 'HTTP/1.1',
  };

  const cgi = spawn('git', ['http-backend'], { env });
  let buffers = [];
  let headerEnd = -1;
  let totalLen = 0;

  cgi.stdout.on('data', (buf) => {
    buffers.push(buf);
    totalLen += buf.length;
    // Search for \r\n\r\n in the accumulated buffers
    if (headerEnd < 0) {
      const all = Buffer.concat(buffers);
      const idx = all.indexOf('\r\n\r\n');
      if (idx >= 0) {
        headerEnd = idx + 4;
        const headerPart = all.subarray(0, headerEnd - 4).toString('utf8');
        headerPart.split('\r\n').forEach(line => {
          const ci = line.indexOf(':');
          if (ci > 0) {
            res.setHeader(line.substring(0, ci), line.substring(ci + 1).trim());
          } else if (line.startsWith('Status:')) {
            res.statusCode = parseInt(line.substring(7).trim().split(' ')[0]) || 200;
          }
        });
        if (!res.headersSent) res.setHeader('Access-Control-Allow-Origin', '*');
        // Write any body data that came after the header boundary
        const bodyData = all.subarray(headerEnd);
        if (bodyData.length > 0) res.write(bodyData);
      }
    } else {
      // Headers already parsed, pass through body
      res.write(buf);
    }
  });

  cgi.stdout.on('end', () => {
    if (!res.headersSent) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.end();
  });

  cgi.stderr.on('data', d => process.stderr.write(d));
  req.pipe(cgi.stdin);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Git HTTP ready on :${PORT}`);
  spawn('git', ['update-server-info'], { cwd: REPO_DIR });
});
