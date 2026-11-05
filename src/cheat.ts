// Cheat / test popup: jump to any level or step, finish steps, unlock everything.
import type { Runtime } from './engine/runtime';
import { progress, ROOM_VI, type Chapter } from './home';

export function openCheat(chapters: Chapter[], rt?: Runtime): void {
  document.querySelector('.cheat')?.remove();
  const el = document.createElement('div');
  el.className = 'cheat';
  const steps = rt?.stepNames ?? [];
  el.innerHTML = `
    <div class="panel">
      <header><b>Cheat test</b><button class="x" aria-label="Đóng">✕</button></header>
      ${rt ? `
      <h3>Màn hiện tại</h3>
      <div class="row">
        <button data-a="skip">Xong bước này</button>
        <button data-a="win">Xong cả màn</button>
        <button data-a="auto">${rt.autoPlay ? 'Tắt' : 'Bật'} tự chơi</button>
      </div>
      <h3>Nhảy tới bước</h3>
      <div class="steps">${steps
        .map((s, i) => `<button data-step="${i}" class="${i === rt.stepIndex ? 'cur' : ''}">${i + 1}. ${s.replace(/^TweenStep-?/, '')}</button>`)
        .join('')}</div>` : ''}
      <h3>Tiến trình</h3>
      <div class="row">
        <button data-a="unlock">${progress.unlockAll() ? 'Khoá lại màn' : 'Mở khoá tất cả'}</button>
        <button data-a="doneall">Đánh dấu xong hết</button>
        <button data-a="reset">Xoá tiến trình</button>
      </div>
      <h3>Chơi thử đồ vật</h3>
      ${chapters
        .map(
          (c) => `<div class="ch"><span>${ROOM_VI[c.code] ?? c.code}</span><div class="lvls">${c.levels
            .map((l) => `<a href="?level=${encodeURIComponent(l.file)}">${l.name}</a>`)
            .join('')}</div></div>`,
        )
        .join('')}
    </div>`;
  const close = () => el.remove();
  el.querySelector('.x')!.addEventListener('click', close);
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) {
      if (e.target === el) close();
      return;
    }
    const a = b.dataset.a;
    const step = b.dataset.step;
    if (rt && step !== undefined) {
      rt.fastForwardTo = Number(step);
      close();
    } else if (rt && a === 'skip') {
      rt.fastForwardTo = rt.stepIndex + 1;
      close();
    } else if (rt && a === 'win') {
      rt.fastForwardTo = 1e9;
      close();
    } else if (rt && a === 'auto') {
      rt.autoPlay = !rt.autoPlay;
      close();
    } else if (a === 'unlock') {
      progress.setUnlockAll(!progress.unlockAll());
      location.reload();
    } else if (a === 'doneall') {
      for (const c of chapters) for (const l of c.levels) progress.markDone(l.file);
      location.reload();
    } else if (a === 'reset') {
      progress.reset();
      location.reload();
    }
  });
  document.body.appendChild(el);
}
