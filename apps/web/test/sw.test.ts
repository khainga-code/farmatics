import { describe, expect, it } from 'vitest';
import { buildId, precacheEntries, renderServiceWorker } from '../tools/sw.js';

/**
 * The service worker used to carry a hand-written cache name, so a deploy
 * could leave a phone serving yesterday's shell. These tests pin the build-time
 * revision: filename changes produce a new id, and the worker is written with
 * that revision and a complete precache list.
 */

describe('service worker revision', () => {
  it('changes when a built asset changes', () => {
    expect(buildId(['assets/index-a.js'])).not.toBe(buildId(['assets/index-b.js']));
  });

  it('does not depend on the order the bundle lists its files', () => {
    expect(buildId(['assets/b.js', 'assets/a.js'])).toBe(buildId(['assets/a.js', 'assets/b.js']));
  });

  it('precaches the shell and every built asset', () => {
    const entries = precacheEntries(['assets/index-x.js', 'assets/index-x.css']);
    expect(entries[0]).toBe('/');
    expect(entries).toContain('/index.html');
    expect(entries).toContain('/manifest.webmanifest');
    expect(entries).toContain('/assets/index-x.js');
    expect(entries).toContain('/assets/index-x.css');
  });

  it('writes the revision into the cache name and the precache list', () => {
    const source = renderServiceWorker({
      buildId: 'abc12345',
      precache: ['/index.html', '/assets/index-x.js'],
    });

    expect(source).toContain('farmatics-shell-abc12345');
    expect(source).toContain('["/index.html","/assets/index-x.js"]');
    expect(source).not.toContain('__BUILD_ID__');
    expect(source).not.toContain('__PRECACHE__');
  });
});
