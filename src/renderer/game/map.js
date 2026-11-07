// Mission map: ground floor of a storage warehouse.
//
//   #  wall          =  steel racking (blocks movement)
//   x  fallen stock  .  floor
//   E  entry door / entry control point
//   a b c  possible casualty locations (one is chosen each run)
//   1  radio checkpoint (report pressure to entry control)

export const TILE = 28;

const ROWS = [
  '########################################',
  '#..........#.........#.......#.........#',
  '#.c........#.........#.......#.........#',
  '#..........#.........#...b...#....a....#',
  '#..........#.........#.......#.........#',
  '####..######..########..######..########',
  '#......................................#',
  '#..====..====..====..====..x...........#',
  '#......................................#',
  '#..====..====..====..====..====..====..#',
  '#.................x....................#',
  '#..====..====..====..====..====..====..#',
  '#......................................#',
  '#..====..====..====..====..====..====..#',
  '#..............1.......................#',
  '#..====..====..====..====..====..====..#',
  '#...........x..........................#',
  '#..====..====..====..====..====..====..#',
  '#......................................#',
  '#E.....................................#',
  '########################################',
];

export const ROOM_NAMES = {
  a: 'the site office',
  b: 'the staff room',
  c: 'the plant room',
};

export function buildMap(rng = Math.random) {
  const h = ROWS.length;
  const w = ROWS[0].length;
  for (const r of ROWS) if (r.length !== w) throw new Error('map rows must be equal length');

  const solid = new Uint8Array(w * h);
  const kind = new Array(w * h);
  const casualtySpots = {};
  let entry = null;
  const checkpoints = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = ROWS[y][x];
      const i = y * w + x;
      kind[i] = ch === '#' ? 'wall' : ch === '=' ? 'rack' : ch === 'x' ? 'debris' : 'floor';
      solid[i] = ch === '#' || ch === '=' || ch === 'x' ? 1 : 0;
      if (ch === 'E') entry = { x: x + 0.5, y: y + 0.5 };
      if (ch === 'a' || ch === 'b' || ch === 'c') casualtySpots[ch] = { x: x + 0.5, y: y + 0.5 };
      if (ch === '1') checkpoints.push({ x: x + 0.5, y: y + 0.5, id: 'aisle', label: 'the central aisle' });
    }
  }

  const keys = Object.keys(casualtySpots);
  const room = keys[Math.floor(rng() * keys.length)];

  return {
    w, h, solid, kind, entry, checkpoints,
    casualty: { ...casualtySpots[room], room, roomName: ROOM_NAMES[room] },
    isSolid(tx, ty) {
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
      return solid[ty * w + tx] === 1;
    },
  };
}
