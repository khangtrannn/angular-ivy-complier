const { compileAngular } = require('./lib/angular-compiler');

// Helper to create mock req/res similar to Express for firebase-functions v6
function mockReqRes(body) {
  const headers = {};
  const res = {
    statusCode: 200,
    _json: null,
    headers: {},
    set(field, value) { this.headers[field.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this._json = obj; console.log('STATUS', this.statusCode); console.log(JSON.stringify(obj, null, 2)); },
    send(txt) { console.log('STATUS', this.statusCode); console.log(txt); }
  };
  const req = { method: 'POST', body, headers };
  return { req, res };
}

async function run() {
  const code = `import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-root',\n  standalone: true,\n  template: '<h1>{{ title }}</h1>',\n})\nexport class App {\n}`;
  const { req, res } = mockReqRes({ code });

  // compileAngular is an onRequest handler wrapper, call the function directly
  await compileAngular(req, res);
}

run().catch(e => { console.error(e); process.exit(1); });
