export function createHistory({ maxChars = 6000 } = {}) {
  let turns = [];
  return {
    add(role, content) {
      turns.push({ role, content: String(content ?? "") });
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
    }
  };
}
