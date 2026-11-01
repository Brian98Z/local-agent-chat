// Registrations are trusted application code, never paths or code supplied by chat
// participants. The host must derive actors from its own authentication layer.
export function createGroupTools() {
  const tools = new Map();
  let sealed = false;
  const validName = (value) => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(value);
  tools.set('text.length', Object.freeze({
    name: 'text.length',
    description: '统计文本的 UTF-16 长度，便于检查聊天消息长度限制。',
    permission: 'member',
    inputSchema: Object.freeze({ type: 'object', properties: { text: { type: 'string', maxLength: 8000 } }, required: ['text'], additionalProperties: false }),
    execute(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args.text !== 'string' || args.text.length > 8000) throw new TypeError('Expected text (at most 8000 UTF-16 units).');
      return { length: args.text.length };
    },
  }));
  return Object.freeze({
    register({ name, description, permission, inputSchema, execute }) {
      if (sealed) throw new Error('Tool registry is sealed.');
      if (!validName(name)) throw new TypeError('Invalid tool name.');
      if (tools.has(name)) throw new Error('Tool already registered.');
      if (typeof description !== 'string' || !description.trim() || description.length > 500) throw new TypeError('Invalid tool description.');
      if (!['admin', 'active', 'member'].includes(permission)) throw new TypeError('Invalid tool permission.');
      if (typeof execute !== 'function') throw new TypeError('Tool handler must be a function.');
      if (inputSchema !== undefined && (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object')) throw new TypeError('Invalid tool input schema.');
      const schema = inputSchema === undefined ? undefined : structuredClone(inputSchema);
      tools.set(name, Object.freeze({ name, description: description.trim(), permission, inputSchema: schema, execute }));
    },
    // Seal before exposing any discovery or invocation endpoint.
    seal() { sealed = true; },
    list(actor) {
      if (!sealed) throw new Error('Tool registry is not sealed.');
      return [...tools.values()].filter((tool) => permitted(actor, tool.permission))
        .map(({ name, description, permission, inputSchema }) => ({ name, description, permission, ...(inputSchema === undefined ? {} : { inputSchema: structuredClone(inputSchema) }) }));
    },
    async invoke(name, args, actor) {
      if (!sealed) throw new Error('Tool registry is not sealed.');
      if (!validName(name)) throw new TypeError('Invalid tool name.');
      const tool = tools.get(name);
      if (!tool) throw Object.assign(new Error('Tool not found.'), { code: 'TOOL_NOT_FOUND' });
      if (!permitted(actor, tool.permission)) throw Object.assign(new Error('Tool permission denied.'), { code: 'TOOL_PERMISSION_DENIED' });
      // Handlers validate their own input and recheck any mutable authorization
      // before side effects. The host must not accept actor from request bodies.
      return await tool.execute(args, Object.freeze({ id: actor.id, admin: actor.admin === true, status: actor.status }));
    },
  });
}

function permitted(actor, permission) {
  if (!actor || typeof actor.id !== 'string' || !actor.id) return false;
  if (actor.admin === true) return true;
  if (permission === 'admin') return false;
  if (permission === 'active') return actor.status === 'active';
  return actor.status === 'active' || actor.status === 'paused';
}
