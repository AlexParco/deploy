import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectRollbackTarget, selectImagesToDelete } from '../dist/core/docker.js';

// Newest first, which is how `docker images` returns them.
const IMAGES = ['app-web:v3', 'app-web:v2', 'app-web:v1'];

test('rolls back to the version right before the deployed one', () => {
  assert.deepEqual(selectRollbackTarget(IMAGES, 'app-web:v3'), {
    from: 'app-web:v3',
    to: 'app-web:v2',
  });
});

test('two rollbacks in a row keep going down, they do not bounce back', () => {
  // The previous bug: images[0] was assumed to be the deployed one. After going
  // back to v2, the second rollback believed it was on v3 and "rolled back" to
  // v2 again — or worse, reinstalled the broken version.
  const first = selectRollbackTarget(IMAGES, 'app-web:v3')!;
  assert.equal(first.to, 'app-web:v2');

  const second = selectRollbackTarget(IMAGES, first.to)!;
  assert.equal(second.to, 'app-web:v1', 'it must keep going down');
});

test('there is no target when the deployed one is the oldest', () => {
  assert.equal(selectRollbackTarget(IMAGES, 'app-web:v1'), null);
});

test('with a single image there is no rollback possible', () => {
  assert.equal(selectRollbackTarget(['app-web:v1'], 'app-web:v1'), null);
});

test('with no images there is no rollback possible', () => {
  assert.equal(selectRollbackTarget([], null), null);
});

test('when the deployed version is unknown, the newest is assumed', () => {
  // The service-is-down case: not reliable, but the best available. The command
  // warns that the "current" version is a guess.
  assert.deepEqual(selectRollbackTarget(IMAGES, null), {
    from: 'app-web:v3',
    to: 'app-web:v2',
  });
});

test('a deployed image no longer in the list breaks nothing', () => {
  assert.deepEqual(selectRollbackTarget(IMAGES, 'app-web:deleted'), {
    from: 'app-web:v3',
    to: 'app-web:v2',
  });
});

// ─── Retention ───────────────────────────────────────────────────────────────

test('the N most recent images of the service are kept', () => {
  const images = ['v5', 'v4', 'v3', 'v2', 'v1'];
  assert.deepEqual(selectImagesToDelete(images, 3, 'v5'), ['v2', 'v1']);
});

test('the image in use is never deleted, even when old', () => {
  // After a rollback the serving version is NOT the most recent one. Deleting
  // it would leave the service unable to restart.
  const images = ['v5', 'v4', 'v3', 'v2', 'v1'];
  const toDelete = selectImagesToDelete(images, 3, 'v1');
  assert.ok(!toDelete.includes('v1'), 'the image in use must survive');
  assert.deepEqual(toDelete, ['v2']);
});

test('with fewer images than the limit nothing is deleted', () => {
  assert.deepEqual(selectImagesToDelete(['v2', 'v1'], 3, 'v2'), []);
});

test('retention applies per service, not to the whole project', () => {
  // The limit used to be global (`docker images 'project-*'`): with two
  // services and keep=3 there was a version and a half of each left, and
  // rollback ran out of targets.
  const web = ['web:v3', 'web:v2', 'web:v1'];
  const api = ['api:v3', 'api:v2', 'api:v1'];
  assert.deepEqual(selectImagesToDelete(web, 3, 'web:v3'), []);
  assert.deepEqual(selectImagesToDelete(api, 3, 'api:v3'), []);
});
