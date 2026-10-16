const test = require('node:test');
const assert = require('node:assert/strict');
const { publicTranscriptionMetadata } = require('../main-services');

test('startup metadata reports saved encrypted keys without returning or decrypting them', () => {
  const result = publicTranscriptionMetadata({ encryptedApiKey: 'fixture-asr-ciphertext', encryptedLlmApiKey: 'fixture-llm-ciphertext', region: 'singapore', workspaceId: 'test-workspace' });
  assert.equal(result.configured, true);
  assert.equal(result.llmConfigured, true);
  assert.equal(result.verificationPending, true);
  assert.equal(result.llmVerificationPending, true);
  assert.equal(result.asrNeedsReentry, false);
  assert.equal(result.llmNeedsReentry, false);
  assert.equal(result.region, 'singapore');
  assert.equal(result.workspaceId, 'test-workspace');
  assert.equal(result.secureStorage, null, 'startup must not claim a keychain access check');
  assert.doesNotMatch(JSON.stringify(result), /fixture|ciphertext/);
});

test('environment credentials avoid encrypted-key verification while unavailable configuration stays unconfigured', () => {
  const absent = publicTranscriptionMetadata();
  assert.equal(absent.configured, false);
  assert.equal(absent.llmConfigured, false);
  assert.equal(absent.verificationPending, false);
  const result = publicTranscriptionMetadata({ encryptedApiKey: 'old-ciphertext' }, { DASHSCOPE_API_KEY: 'fixture-env-key', NOTCH_LLM_API_KEY: 'fixture-env-llm', DASHSCOPE_REGION: 'singapore', DASHSCOPE_WORKSPACE_ID: 'invalid space' });
  assert.equal(result.configured, true);
  assert.equal(result.llmConfigured, true);
  assert.equal(result.verificationPending, false);
  assert.equal(result.llmVerificationPending, false);
  assert.equal(result.workspaceId, '');
  assert.doesNotMatch(JSON.stringify(result), /fixture|ciphertext/);
});
