// Home screen, chapter progress and the story pictures of the original game.
// Progress lives in localStorage: which levels are done and which story pages were seen.
const BASE = import.meta.env.BASE_URL + 'data/story/';

export interface Chapter {
  code: string;
  levels: { file: string; name: string }[];
}

export const ROOM_VI: Record<string, string> = {
  LivingRoom: 'Phòng khách', Kitchen: 'Phòng bếp', Bathroom: 'Phòng tắm', Bedroom: 'Phòng ngủ', Inhouse: 'Trong nhà',
  Outdoor: 'Ngoài trời', Pool: 'Hồ bơi', Garden: 'Khu vườn', Yard: 'Sân nhà', Gara: 'Gara', Playground: 'Sân chơi',
};

/** Story pictures per chapter: op = before (dirty), ed = after (clean). */
const STORY: Record<string, { op?: string; ed?: string; opText: string; edText: string }> = {
  LivingRoom: { op: 'bg_loading', opText: 'Một đêm giông bão, hai mẹ con dọn về căn nhà cũ bỏ hoang…', edText: 'Phòng khách đã sáng sủa trở lại!' },
  Kitchen: { op: 'story_2_op_1', ed: 'story_2_ed_1', opText: 'Căn bếp bám đầy dầu mỡ, rêu mốc và rác.', edText: 'Căn bếp sạch bong, sẵn sàng nấu bữa cơm đầu tiên.' },
  Bathroom: { op: 'story_3_op_1', ed: 'story_3_ed_1', opText: 'Phòng tắm tối tăm, ẩm mốc khắp nơi.', edText: 'Phòng tắm trắng tinh, thơm mát.' },
  Bedroom: { op: 'story_5_op_1', ed: 'story_5_ed_1', opText: 'Phòng ngủ ngổn ngang đồ đạc cũ nát.', edText: 'Một góc nghỉ ngơi ấm cúng cho cả nhà.' },
  Inhouse: { op: 'story_9_op_1', ed: 'story_9_ed_1', opText: 'Cây đàn, đồng hồ, cánh cửa… tất cả phủ bụi dày.', edText: 'Ngôi nhà bên trong đã hoàn toàn đổi mới!' },
  Outdoor: { op: 'story_8_op_1', ed: 'story_8_ed_1', opText: 'Mặt tiền ngôi nhà xuống cấp, mái và tường bong tróc.', edText: 'Ngôi nhà khoác lên diện mạo mới.' },
  Pool: { op: 'story_7_op_1', ed: 'story_7_ed_1', opText: 'Hồ bơi cạn nước, đầy lá mục và rong rêu.', edText: 'Hồ bơi trong xanh mát lạnh.' },
  Garden: { op: 'story_4_op_1', ed: 'story_4_ed_1', opText: 'Khu vườn hoang tàn, xe cũ gỉ sét giữa bùn lầy.', edText: 'Khu vườn rực rỡ sắc màu.' },
  Yard: { ed: 'story_6_ed_1', opText: 'Sân nhà cỏ dại mọc um tùm.', edText: 'Sân nhà xinh xắn với hộp thư và vòi phun.' },
  Gara: { op: 'story_10_op_1', ed: 'story_10_ed_1', opText: 'Gara chất đầy phụ tùng và dầu nhớt.', edText: 'Gara gọn gàng, xe lại bóng loáng.' },
  Playground: { op: 'story_11_op_1', opText: 'Ngôi nhà trên cây và sân chơi bị bỏ quên.', edText: 'Sân chơi rộn rã tiếng cười của bé!' },
};

const DONE_KEY = 'home-clean-web.done';
const SEEN_KEY = 'home-clean-web.story';
const UNLOCK_KEY = 'home-clean-web.unlockAll';

function readSet(k: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(k) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function writeSet(k: string, s: Set<string>): void {
  try {
    localStorage.setItem(k, JSON.stringify([...s]));
  } catch {
    /* private mode */
  }
}

export const progress = {
  done: () => readSet(DONE_KEY),
  markDone(file: string): void {
    const s = readSet(DONE_KEY);
    s.add(file);
    writeSet(DONE_KEY, s);
  },
  seen: () => readSet(SEEN_KEY),
  markSeen(id: string): void {
    const s = readSet(SEEN_KEY);
    s.add(id);
    writeSet(SEEN_KEY, s);
  },
  unlockAll(): boolean {
    try {
      return localStorage.getItem(UNLOCK_KEY) === '1';
    } catch {
      return false;
    }
  },
  setUnlockAll(on: boolean): void {
    try {
      localStorage.setItem(UNLOCK_KEY, on ? '1' : '0');
    } catch {
      /* private mode */
    }
  },
  reset(): void {
    try {
      localStorage.removeItem(DONE_KEY);
      localStorage.removeItem(SEEN_KEY);
      localStorage.removeItem(UNLOCK_KEY);
    } catch {
      /* private mode */
    }
  },
};

/** Levels open in order: a level opens when the one before it is done. */
export function isOpen(chapters: Chapter[], file: string): boolean {
  if (progress.unlockAll()) return true;
  const done = progress.done();
  const all = chapters.flatMap((c) => c.levels.map((l) => l.file));
  const i = all.indexOf(file);
  return i <= 0 || done.has(file) || done.has(all[i - 1]);
}

export function chapterOf(chapters: Chapter[], file: string): Chapter | undefined {
  return chapters.find((c) => c.levels.some((l) => l.file === file));
}

/** URL of a chapter's story picture (op = dirty, ed = clean), if the game has one. */
export function storyImage(code: string, which: 'op' | 'ed'): string | undefined {
  const img = STORY[code]?.[which];
  return img ? `${BASE}${img}.webp` : undefined;
}

/** Full-screen story page; resolves when the player taps on. */
export function showStory(code: string, which: 'op' | 'ed'): Promise<void> {
  const st = STORY[code];
  const img = st?.[which];
  if (!st || !img) return Promise.resolve();
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'story';
    el.innerHTML = `<img src="${BASE}${img}.webp" alt=""><div class="cap"><p>${which === 'op' ? st.opText : st.edText}</p><button>Tiếp tục</button></div>`;
    el.querySelector('button')!.addEventListener('click', () => {
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        resolve();
      }, 250);
    });
    document.body.appendChild(el);
  });
}

export function showHome(chapters: Chapter[], onCheat: () => void): void {
  const done = progress.done();
  const el = document.createElement('div');
  el.className = 'menu homepage';
  el.innerHTML = `<img class="logo" src="${BASE}Logo.webp" alt="Home Cleaning ASMR">`;
  const total = chapters.reduce((a, c) => a + c.levels.length, 0);
  const doneN = chapters.reduce((a, c) => a + c.levels.filter((l) => done.has(l.file)).length, 0);
  const sum = document.createElement('div');
  sum.className = 'sum';
  sum.innerHTML = `<span>Tiến trình ngôi nhà</span><b>${doneN}/${total}</b><i style="--p:${(doneN / Math.max(1, total)) * 100}%"></i>`;
  el.appendChild(sum);
  for (const ch of chapters) {
    const n = ch.levels.filter((l) => done.has(l.file)).length;
    const complete = n === ch.levels.length;
    const st = STORY[ch.code];
    const pic = (complete ? st?.ed : st?.op) ?? st?.op ?? st?.ed;
    const open = ch.levels.some((l) => isOpen(chapters, l.file));
    const card = document.createElement('section');
    card.className = `chapter${complete ? ' complete' : ''}${open ? '' : ' locked'}`;
    const room = `?room=${encodeURIComponent(ch.code)}`;
    card.innerHTML = `
      <div class="cover" style="background-image:url('${BASE}${pic}.webp')">
        <div class="shade"></div>
        <h2>${ROOM_VI[ch.code] ?? ch.code}</h2>
        <button class="story-btn" aria-label="Xem chuyện">📖</button>
        <div class="bar"><i style="--p:${(n / ch.levels.length) * 100}%"></i><span>${n}/${ch.levels.length}</span></div>
        ${complete ? `<a class="badge" href="${room}">✓ Hoàn thành</a>` : open ? `<a class="play" href="${room}">${n ? 'Chơi tiếp' : 'Bắt đầu'}</a>` : '<div class="badge lock">🔒 Chưa mở</div>'}
      </div>`;
    // the cover opens the room (its objects are picked there); the book button tells the story
    card.querySelector('.story-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      void showStory(ch.code, complete ? 'ed' : 'op');
    });
    card.querySelector('.cover')!.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a,button')) return;
      if (open) location.search = room;
    });
    el.appendChild(card);
  }
  const cheat = document.createElement('button');
  cheat.className = 'cheat-btn';
  cheat.textContent = '🛠';
  cheat.setAttribute('aria-label', 'Cheat test');
  cheat.addEventListener('click', onCheat);
  document.body.append(el, cheat);
  // first launch: the opening story
  if (!progress.seen().has('intro')) {
    progress.markSeen('intro');
    void showStory('LivingRoom', 'op');
  }
}
