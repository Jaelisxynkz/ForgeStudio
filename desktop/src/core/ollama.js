'use strict';
// Talks to Ollama, the free open-source runner that keeps models and inference on this computer.

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,119}(:[A-Za-z0-9._\-]{1,60})?$/;

function createOllama({ base = 'http://127.0.0.1:11434', fetchImpl = fetch } = {}) {
  async function failure(res) {
    const body = await res.text();
    let message = body.slice(0, 300);
    try { message = JSON.parse(body).error || message; } catch (error) { /* the error body was plain text */ }
    return new Error('Ollama: ' + (message || 'HTTP ' + res.status));
  }

  async function status() {
    let res;
    try {
      res = await fetchImpl(base + '/api/version', { signal: AbortSignal.timeout(2500) });
    } catch (error) {
      return { running: false, version: '' };
    }
    if (!res.ok) return { running: false, version: '' };
    const data = await res.json();
    return { running: true, version: String(data.version || '') };
  }

  async function list() {
    const res = await fetchImpl(base + '/api/tags', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw await failure(res);
    const data = await res.json();
    return (data.models || []).map((m) => ({
      name: String(m.name),
      size: Number(m.size) || 0,
      parameters: (m.details && m.details.parameter_size) || '',
      quantization: (m.details && m.details.quantization_level) || '',
    }));
  }

  function checkName(name) {
    if (typeof name !== 'string' || !MODEL_NAME.test(name)) throw new Error('That is not a valid model name');
    return name;
  }

  async function pull(name, onProgress = () => {}) {
    const res = await fetchImpl(base + '/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: checkName(name), stream: true }),
    });
    if (!res.ok) throw await failure(res);
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    const read = (line) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.error) throw new Error('Ollama: ' + event.error);
      if (event.status === 'success') done = true;
      onProgress({ status: String(event.status || ''), total: Number(event.total) || 0, completed: Number(event.completed) || 0 });
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(read);
    }
    read(buffer);
    if (!done) throw new Error('Ollama stopped the download before it finished');
  }

  async function remove(name) {
    const res = await fetchImpl(base + '/api/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: checkName(name) }),
    });
    if (!res.ok) throw await failure(res);
  }

  // One non-streamed answer constrained to a JSON schema.
  async function chatJson({ model, prompt, schema }) {
    const res = await fetchImpl(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: checkName(model),
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: schema,
        options: { temperature: 0.2, num_ctx: 8192 },
      }),
    });
    if (!res.ok) throw await failure(res);
    const data = await res.json();
    const content = data && data.message && data.message.content;
    let parsed = null;
    try { parsed = JSON.parse(content); } catch (error) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') throw new Error('The model did not return a usable answer. Try again or pick a larger model.');
    return parsed;
  }

  return { status, list, pull, remove, chatJson };
}

module.exports = { createOllama, MODEL_NAME };
