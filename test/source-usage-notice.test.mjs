import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceUsageNotices } from '../src/source-usage-notice.mjs';

test('source access notices deduplicate by content while preserving distinct notices',()=>{
  const a={usage_notice:{text:'ECB data is available free of charge.',url:'https://www.ecb.europa.eu/',label:'Original ECB data'}};
  const b={usage_notice:{text:'A separate attribution is required.'}};
  assert.deepEqual(sourceUsageNotices([a,a,b]),[a.usage_notice,b.usage_notice]);
});
test('untrusted notice links cannot execute scripts or expose credentials',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,x','https://user:secret@example.com/','not a URL'])
    assert.deepEqual(sourceUsageNotices([{usage_notice:{text:'Keep the attribution.',url}}]),[{text:'Keep the attribution.'}]);
  assert.deepEqual(sourceUsageNotices([{usage_notice:{}},{usage_notice:{text:''}}]),[]);
});
