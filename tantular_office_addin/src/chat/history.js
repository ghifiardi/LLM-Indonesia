export function createHistory({ maxChars = 6000 } = {}) {
  let turns = [];
  let scopeKey = null;
  return {
    add(role, content) {
      turns.push({ role, content: String(content ?? "") });
    },
    // A prior answer about a different document/selection is not evidence for
    // the current request. Keep the chat transcript in the UI, but never send
    // its old turns to the model after the source context changes.
    setScope(key) {
      const next = String(key ?? "none");
      if (scopeKey === next) return false;
      turns = [];
      scopeKey = next;
      return true;
    },
    toMessages() {
      const result = [];
      let total = 0;
      for (let i = turns.length - 1; i >= 0; i--) {
        const { role, content } = turns[i];
        if (result.length === 0 && content.length > maxChars) {
          result.unshift({ role, content: content.slice(0, maxChars) });
          break;
        }
        if (total + content.length > maxChars) break;
        total += content.length;
        result.unshift({ role, content });
      }
      return result;
    },
    clear() {
      turns = [];
      scopeKey = null;
    }
  };
}
