/** 模拟 chat/completions：按关键词回答，供回归回放 */
import http from 'node:http';
let n = 0;
const port = Number(process.argv[2] || 9941);
http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) { res.writeHead(404).end(); return; }
  if (!req.headers.authorization?.startsWith('Bearer ')) { res.writeHead(401).end(JSON.stringify({ error: 'no key' })); return; }
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(body).toString();
    n += 1;
    let content = '这是一条普通回答。';
    if (raw.includes('EVAL-')) { const m = raw.match(/EVAL-[0-9A-F]{6}/); content = m ? m[0] : content; }
    else if (raw.includes('1+1')) content = '2';
    else if (raw.includes('1998')) content = '我不知道我们公司 1998 年的营收。';
    else if (raw.includes('你好')) content = 'Hello!';
    if (n === 3) content = '（安全拒答）';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
}).listen(port, '127.0.0.1', () => console.log('mock regression server on ' + port));
