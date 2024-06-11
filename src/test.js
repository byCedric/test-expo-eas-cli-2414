import assert from 'node:assert';
import { createServer } from 'node:http';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { File } from 'node:buffer';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';

import './memory.js';

const testFile = resolveFilePath('../christian-joudrey-sequoia.jpg');

test('sends FormData correctly with a file', async () => {
  /** @type {FormData} */
  let data;
  /** @type {Headers} */
  let headers;

  // Create a server that pulls the form info from the request
  const server = createServer(async (req, res) => {
    const request = convertRequest(req, res);
    // Since we actually start a server in this test, it will trigger a warning:
    //   ExperimentalWarning: buffer.File is an experimental feature and might change at any time
    // This helps testing for correctness, but should not be triggered by the upload mechanism
    if (!env.TEST_NO_WARNINGS) {
      data = await request.formData();
    }
    headers = request.headers;
    res.end();
  });

  // Start the server on an ephemeral port
  const port = await new Promise((resolve) => {
    server.listen(undefined, 'localhost', () => {
      resolve(server.address().port);
    });
  });

  // Create a FormData object, and populate data
  const form = new FormData();
  const file = await createBlobFromPath(testFile);
  form.append('some-value', 'value');
  form.append('file', file, path.basename(testFile));

  // Send the FormData to the server
  const response = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    body: form,
  });

  // Assert the request is successful
  assert.equal(response.ok, true);

  // Assert the FormData was received correctly
  assert.equal(headers.get('content-type').startsWith('multipart/form-data'), true);
  assert.equal(!Number.isNaN(parseInt(headers.get('content-length'))), true);
  assert.equal(parseInt(headers.get('content-length')) > 0, true);

  // Assert the FormData was received correctly, if enabled
  if (data) {
    assert.equal(data.get('some-value'), 'value');
    assert.equal(data.get('file') instanceof File, true);
    assert.equal(data.get('file').name, path.basename(testFile));
    assert.equal(data.get('file').size, file.size);
  }

  // Dump the data for inspection
  console.log();
  console.log('Request headers:', Object.fromEntries(headers.entries()));
  console.log('Request data:', data ? Object.fromEntries(data.entries()) : '<no data>');
  console.log();
  console.log('Response headers:', Object.fromEntries(response.headers.entries()));
  console.log();

  // Close the server
  server.close();
});

// This approach works, but requires faking quite a lot
async function createBlobFromPath(filePath) {
  if (typeof fs.openAsBlob === 'function') {
    console.log('Using fs.openAsBlob:', filePath);
    return await fs.openAsBlob(filePath);
  }

  console.log('Falling back to File polyfill:', filePath);
  const { size } = await fs.promises.stat(filePath);

  return {
    [Symbol.toStringTag]: 'File', // Trick Node into thinking this is a File reference
    get type() { return undefined }, // Always undefined, it's the mime type
    get size() { return size }, // Ensure the `content-length` header is set through form data
    stream() { return Readable.toWeb(fs.createReadStream(filePath)) }, // The magic part that makes it work

    // Not necessary as we override the filename through formdata
    // get name() { return name },

    // Could add the full API, but it's not necessary for form data
    // arrayBuffer(...args) { return this.stream().arrayBuffer(...args) },
    // text(...args) { return this.stream().text(...args) },
    // slice(...args) { return this.stream().slice(...args) }
  };
}

/**
 * Resolve the file path from the current's file directory.
 * Node 18 doesn't have `import.meta.dirname`, so it's a bit hacky.
 * This is the equivalent of `path.resolve(__dirname, relativePath)`, but for ESM / Node 18+.
 */
function resolveFilePath(relativePath) {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), relativePath);
}

/**
 * Convert an IncomingMessage to Request object, copied from `@remix-run/node`.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Request}
 */
function convertRequest(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const headers = new Headers();

  for (const [key, values] of Object.entries(req.headers)) {
    if (values) {
      if (Array.isArray(values)) {
        for (const value of values) {
          headers.append(key, value);
        }
      } else {
        headers.set(key, values);
      }
    }
  }

  const requestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const pump = new StreamPump(req);
    requestInit.body = new ReadableStream(pump, pump);
    requestInit.duplex = 'half';
  }

  return new Request(requestUrl.href, requestInit);
}
class StreamPump {
  highWaterMark;
  accumalatedSize;
  stream;
  controller;

  constructor(stream) {
    this.highWaterMark =
      stream.readableHighWaterMark ||
      new Stream.Readable().readableHighWaterMark;
    this.accumalatedSize = 0;
    this.stream = stream;
    this.enqueue = this.enqueue.bind(this);
    this.error = this.error.bind(this);
    this.close = this.close.bind(this);
  }

  size(chunk) {
    return chunk?.byteLength || 0;
  }

  start(controller) {
    this.controller = controller;
    this.stream.on("data", this.enqueue);
    this.stream.once("error", this.error);
    this.stream.once("end", this.close);
    this.stream.once("close", this.close);
  }

  pull() {
    this.resume();
  }

  cancel(reason) {
    if (this.stream.destroy) {
      this.stream.destroy(reason);
    }

    this.stream.off("data", this.enqueue);
    this.stream.off("error", this.error);
    this.stream.off("end", this.close);
    this.stream.off("close", this.close);
  }

  enqueue(chunk) {
    if (this.controller) {
      try {
        let bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);

        let available = (this.controller.desiredSize || 0) - bytes.byteLength;
        this.controller.enqueue(bytes);
        if (available <= 0) {
          this.pause();
        }
      } catch (error) {
        this.controller.error(
          new Error(
            "Could not create Buffer, chunk must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object"
          )
        );
        this.cancel();
      }
    }
  }

  pause() {
    if (this.stream.pause) {
      this.stream.pause();
    }
  }

  resume() {
    if (this.stream.readable && this.stream.resume) {
      this.stream.resume();
    }
  }

  close() {
    if (this.controller) {
      this.controller.close();
      delete this.controller;
    }
  }

  error(error) {
    if (this.controller) {
      this.controller.error(error);
      delete this.controller;
    }
  }
}
