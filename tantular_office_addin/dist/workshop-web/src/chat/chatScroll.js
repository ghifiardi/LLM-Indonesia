// Where to scroll the chat's message list so a card that just changed is in
// view. A preview card that grows after it was appended (live values, an
// error, the result) used to stay below the list's visible window, which
// looked like a card cut off after its heading. Pure for unit tests.

// view / node: getBoundingClientRect() results; returns the new scrollTop.
export function revealScrollTop(view, node, scrollTop) {
  if (node.height >= view.height) return scrollTop + (node.top - view.top); // too tall: show its top
  if (node.bottom > view.bottom) return scrollTop + (node.bottom - view.bottom);
  if (node.top < view.top) return scrollTop + (node.top - view.top);
  return scrollTop;
}
