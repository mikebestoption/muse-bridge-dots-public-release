'use strict';

// Loops library store (Muse Bridge v0.4.0).
// - A loop is { id, name, description, steps[], createdAt, updatedAt },
//   stored locally ONLY in the app's userData folder (loops.json).
// - Steps are validated/normalized by src/loopsCore.js — the same pure
//   module the renderer loads, so what the builder saves is exactly
//   what the runner and the documentation view describe.
// - Loops contain NO secrets: a fill step carries a vault entry LABEL
//   only, exactly like a model-proposed fill action. There is no
//   network code here; loops never leave the machine on their own.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./loopsCore');

function createLoopsStore(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new Error('createLoopsStore requires a userData path.');
  }
  const loopsFile = path.join(userDataPath, 'loops.json');

  function readRaw() {
    try {
      if (fs.existsSync(loopsFile)) {
        const parsed = JSON.parse(fs.readFileSync(loopsFile, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {
      // Corrupt loops file: fall back to an empty library rather than crashing.
    }
    return [];
  }

  function writeRaw(loops) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(loopsFile, JSON.stringify(loops, null, 2), 'utf8');
  }

  function makeId() {
    return `loop-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  }

  function toPublic(loop) {
    return {
      id: loop.id,
      name: loop.name,
      description: loop.description,
      steps: loop.steps,
      createdAt: loop.createdAt,
      updatedAt: loop.updatedAt
    };
  }

  function list() {
    return readRaw().map(toPublic);
  }

  function get(id) {
    const loop = readRaw().find((l) => l.id === id);
    return loop ? toPublic(loop) : null;
  }

  function create(data) {
    // Validate BEFORE writing, so a bad payload leaves no partial loop.
    const clean = core.validateLoopData(data);
    const now = new Date().toISOString();
    const loop = { id: makeId(), ...clean, createdAt: now, updatedAt: now };
    const loops = readRaw();
    loops.push(loop);
    writeRaw(loops);
    return toPublic(loop);
  }

  function update(id, data) {
    const loops = readRaw();
    const idx = loops.findIndex((l) => l.id === id);
    if (idx === -1) throw new Error('That loop no longer exists.');
    const clean = core.validateLoopData(data);
    loops[idx] = { ...loops[idx], ...clean, updatedAt: new Date().toISOString() };
    writeRaw(loops);
    return toPublic(loops[idx]);
  }

  function remove(id) {
    const loops = readRaw();
    const idx = loops.findIndex((l) => l.id === id);
    if (idx === -1) return false;
    loops.splice(idx, 1);
    writeRaw(loops);
    return true;
  }

  return { list, get, create, update, remove };
}

module.exports = { createLoopsStore };
