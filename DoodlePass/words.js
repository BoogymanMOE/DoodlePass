// ~200 drawable words, grouped loosely by category. Keep them concrete and
// sketchable with freehand drawing — no abstract nouns.
export const WORDS = [
  // Animals (30)
  'elephant', 'giraffe', 'penguin', 'butterfly', 'octopus', 'kangaroo', 'snake',
  'spider', 'turtle', 'dolphin', 'shark', 'eagle', 'owl', 'whale', 'lion', 'tiger',
  'zebra', 'horse', 'cow', 'pig', 'sheep', 'chicken', 'duck', 'frog', 'mouse',
  'rabbit', 'bear', 'panda', 'monkey', 'dinosaur',

  // Food & drink (30)
  'pizza', 'hamburger', 'banana', 'apple', 'orange', 'grapes', 'watermelon',
  'strawberry', 'carrot', 'potato', 'tomato', 'corn', 'bread', 'cheese', 'egg',
  'milk', 'cookie', 'cake', 'donut', 'ice cream', 'popcorn', 'hot dog', 'taco',
  'sushi', 'spaghetti', 'pancake', 'pineapple', 'avocado', 'cherry', 'coconut',

  // Objects (35)
  'umbrella', 'scissors', 'toothbrush', 'key', 'clock', 'lamp', 'mirror', 'comb',
  'backpack', 'wallet', 'glasses', 'camera', 'telephone', 'television', 'computer',
  'keyboard', 'candle', 'balloon', 'kite', 'rocket', 'boat', 'train', 'bicycle',
  'helicopter', 'ladder', 'hammer', 'guitar', 'drum', 'piano', 'book', 'pencil',
  'envelope', 'crown', 'sword', 'lantern',

  // Places & nature (30)
  'sun', 'moon', 'rainbow', 'cloud', 'rain', 'snowflake', 'volcano', 'island',
  'mountain', 'river', 'waterfall', 'cactus', 'tree', 'flower', 'mushroom', 'star',
  'lightning', 'tornado', 'desert', 'beach', 'house', 'castle', 'bridge',
  'lighthouse', 'windmill', 'fountain', 'tent', 'igloo', 'pyramid', 'garden',

  // Actions (25)
  'dancing', 'sleeping', 'running', 'swimming', 'fishing', 'cooking', 'skiing',
  'surfing', 'gardening', 'climbing', 'boxing', 'crying', 'laughing', 'juggling',
  'skating', 'riding a bike', 'taking a photo', 'playing guitar', 'brushing teeth',
  'reading', 'hiding', 'singing', 'juggling hoops', 'weightlifting', 'meditating',

  // People & professions (20)
  'doctor', 'firefighter', 'police officer', 'pirate', 'ninja', 'astronaut', 'chef',
  'teacher', 'clown', 'magician', 'farmer', 'artist', 'surgeon', 'dentist',
  'scientist', 'viking', 'princess', 'superhero', 'detective', 'mailman',

  // Fantasy & misc (20)
  'ghost', 'robot', 'dragon', 'unicorn', 'mermaid', 'snowman', 'witch', 'alien',
  'wizard', 'vampire', 'treasure map', 'jellyfish', 'roller coaster', 'traffic light',
  'stop sign', 'fire hydrant',  'birthday present', 'christmas tree', 'eyeglasses', 'sandcastle',

  // More objects (12)
  'trumpet', 'violin', 'telescope', 'microscope', 'sled', 'flag', 'anchor',
  'horseshoe', 'acorn', 'seashell', 'binoculars', 'typewriter',
];

const UNIQUE = [...new Set(WORDS.map((w) => w.toLowerCase()))];

/** Pick a random word not in `used` (falls back to the full list once exhausted). */
export function pickWord(used = []) {
  const taken = new Set(used.map((w) => w.toLowerCase()));
  const available = UNIQUE.filter((w) => !taken.has(w));
  const pool = available.length ? available : UNIQUE;
  return pool[Math.floor(Math.random() * pool.length)];
}

export { UNIQUE as WORD_LIST };
