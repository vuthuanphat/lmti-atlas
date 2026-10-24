import test from 'node:test';
import assert from 'node:assert/strict';
import { strictJson } from '../dist/security.js';

test('strict JSON rejects duplicate/escaped keys, unsafe numbers, UTF-8 and deep input',() => {
  for (const text of ['{"revision":0,"revision":1}','{"id":1,"\\u0069d":2}','{"__proto__":{}}','{"n":1e999}','[1,]','true false','{"a":'+ '['.repeat(30)+'0'+']'.repeat(30)+'}'])
    assert.throws(() => strictJson(Buffer.from(text)));
  assert.throws(() => strictJson(Buffer.from([0xff])));
  const good = strictJson(Buffer.from('{"label":"Một dự án","revision":0,"servers":[]}'));
  assert.equal(good.label,'Một dự án'); assert.equal(good.revision,0);
  const privateMap = strictJson(Buffer.from('{"servers":{"constructor":{"url":"https://example.com/mcp"}}}'),false);
  assert.equal(Object.getPrototypeOf(privateMap.servers),null);
  assert.equal(privateMap.servers.constructor.url,'https://example.com/mcp');
});
