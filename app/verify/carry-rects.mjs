// Where the card in hand is on screen against the name tags it must not cover. Reads real screen rectangles from the page:
// the card as drawn (scale, tilt and slide included), the line under it, and every name tag, bubble and desk label that is
// showing. A tag the first-person view fades out, or a wall hides, is not showing and is not counted.
const READ = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const showing = (el) => {
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && css.visibility !== 'hidden' && css.display !== 'none' && Number(css.opacity) > 0.03 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const cardEl = document.querySelector('.tb-ghost-in .tb-card');
  const lineEl = document.querySelector('[data-testid=ghost-aim]');
  const tags = [...document.querySelectorAll('.emp-label, .desk-aim')].filter(showing).map((el) => ({ name: (el.innerText || '').replace(/\\s+/g, ' ').trim(), ...box(el) }));
  return { card: cardEl && box(cardEl), line: lineEl && box(lineEl), tags };
})()`;

const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const near = (a, b) => !a || !b || [a.left - b.left, a.top - b.top, a.right - b.right, a.bottom - b.bottom].every((d) => Math.abs(d) < 0.6);

// The rectangles once the card has stopped sliding (it eases to its place over about 0.16 s).
export async function carryRects(s) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    const now = await s.eval(READ);
    if (last && near(last.card, now.card) && near(last.line, now.line)) return now;
    last = now;
    await s.sleep(120);
  }
  return last;
}

// What the card and its line cover, by name, and how far the card is from the pointer.
export async function carryClearance(s, pointer) {
  const r = await carryRects(s);
  if (!r.card) throw new Error('no card in hand to measure');
  const covered = r.tags.filter((t) => meets(r.card, t) || (r.line && meets(r.line, t))).map((t) => t.name);
  const away = Math.hypot((r.card.left + r.card.right) / 2 - pointer.x, (r.card.top + r.card.bottom) / 2 - pointer.y);
  return { covered, tags: r.tags.length, away: Math.round(away), card: r.card, line: r.line };
}
