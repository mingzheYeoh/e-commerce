/**
 * The words in the demo data: who the customers are and where they live, what
 * they write in reviews and ask about products, and what sellers answer.
 *
 * Kept apart from seed-demo.ts, which decides what happens and when; this only
 * decides how it reads. Every template is written for a kind of product (a
 * charger is not reviewed for its keyboard), and each review is assembled from
 * an opener, one or two sentences about the product, and sometimes a word on
 * delivery, so a few hundred of them do not read as copies of each other.
 */

export type Kind =
  | 'phone'
  | 'earbuds'
  | 'headphones'
  | 'speaker'
  | 'music'
  | 'laptop'
  | 'charger'
  | 'powerbank'
  | 'watch'
  | 'webcam'
  | 'stabiliser'
  | 'drone'
  | 'camera'
  | 'keyboard'
  | 'switches'
  | 'mouse'
  | 'monitor'

const BY_ID: Record<string, Kind> = {
  'cmf-buds': 'earbuds',
  'soundcore-liberty': 'earbuds',
  'ear-open': 'earbuds',
  'galaxy-buds': 'earbuds',
  'open-earbuds': 'earbuds',
  'momentum-4': 'headphones',
  'qc-ultra': 'headphones',
  wh1000xm6: 'headphones',
  'airpods-max': 'headphones',
  hd900s: 'headphones',
  'soundlink-max': 'speaker',
  'ob4-speaker': 'speaker',
  'tp7-recorder': 'music',
  'op1-field': 'music',
  'gan-charger': 'charger',
  'prime-powerbank': 'powerbank',
  'watch-ultra': 'watch',
  'brio-webcam': 'webcam',
  'osmo-pocket': 'stabiliser',
  'rs4-gimbal': 'stabiliser',
  'mavic-4-pro': 'drone',
  'switch-set': 'switches',
  'k-pro-mouse': 'mouse',
  'mx-master': 'mouse',
  'viper-v3': 'mouse',
  'odyssey-oled': 'monitor',
}

const BY_CATEGORY: Record<string, Kind> = {
  phones: 'phone',
  audio: 'headphones',
  computing: 'laptop',
  peripherals: 'keyboard',
  imaging: 'camera',
}

export const kindOf = (id: string, category: string): Kind => BY_ID[id] ?? BY_CATEGORY[category] ?? 'laptop'

/** How often a kind is bought, before price is taken into account. */
export const POPULARITY: Record<Kind, number> = {
  phone: 3,
  earbuds: 3,
  headphones: 2.2,
  speaker: 1.2,
  music: 0.5,
  laptop: 1.6,
  charger: 1.5,
  powerbank: 1.5,
  watch: 1,
  webcam: 1,
  stabiliser: 0.9,
  drone: 0.7,
  camera: 0.7,
  keyboard: 1.8,
  switches: 1,
  mouse: 2,
  monitor: 0.8,
}

/** What a buyer of one kind tends to add to the same order. */
export const GOES_WITH: Partial<Record<Kind, Kind[]>> = {
  phone: ['earbuds', 'charger', 'powerbank', 'watch'],
  laptop: ['mouse', 'charger', 'keyboard'],
  camera: ['stabiliser'],
  keyboard: ['mouse', 'switches'],
  monitor: ['keyboard', 'mouse', 'webcam'],
  drone: ['powerbank'],
}

/* ------------------------------------------------------------------ people */

export type Country = 'MY' | 'SG' | 'US' | 'AU' | 'GB'

/**
 * First and last names that belong together. Malaysia's are grouped by
 * community, so nobody is called Izzati Pillai; the weights follow roughly who
 * shops online there.
 */
const MY_GROUPS: [string[], string[], number][] = [
  [
    ['Aina', 'Hafiz', 'Nabila', 'Syafiq', 'Amirul', 'Liyana', 'Irfan', 'Farah', 'Hakim', 'Izzati', 'Danial', 'Aiman'],
    ['Rahman', 'Ismail', 'Hassan', 'Abdullah', 'Aziz', 'Zakaria', 'Yusof', 'Karim'],
    5,
  ],
  [
    ['Wei Ling', 'Jun Hao', 'Mei Qi', 'Kelvin', 'Michelle', 'Jason', 'Chloe', 'Darren', 'Yee Ling', 'Marcus', 'Joanne', 'Ethan'],
    ['Tan', 'Lim', 'Wong', 'Ng', 'Lee', 'Chong', 'Ooi', 'Teh', 'Goh', 'Chan', 'Yap', 'Khoo'],
    4,
  ],
  [
    ['Priya', 'Arjun', 'Kavitha', 'Suresh', 'Divya', 'Ravi', 'Anand', 'Shalini', 'Vikram', 'Deepa'],
    ['Nair', 'Raj', 'Subramaniam', 'Kumar', 'Pillai', 'Menon', 'Krishnan'],
    1.5,
  ],
]

const SG_GROUPS: [string[], string[], number][] = [
  [
    ['Ryan', 'Amanda', 'Nicholas', 'Hui Min', 'Sheryl', 'Benjamin', 'Rachel', 'Zhi Wei', 'Gabriel', 'Esther'],
    ['Teo', 'Koh', 'Chua', 'Lee', 'Ong', 'Tay', 'Lim', 'Goh', 'Sim', 'Ho'],
    4,
  ],
  [['Farhan', 'Nurul', 'Hidayah', 'Irwan'], ['Salleh', 'Rahim', 'Osman', 'Jamil'], 1],
]

const FIRST: Record<Exclude<Country, 'MY' | 'SG'>, string[]> = {
  US: ['Emily', 'Jake', 'Olivia', 'Marcus', 'Hannah', 'Tyler', 'Grace', 'Daniel', 'Megan', 'Andrew'],
  AU: ['Liam', 'Chloe', 'Jack', 'Isla', 'Noah', 'Ruby', 'Lachlan', 'Matilda'],
  GB: ['Oliver', 'Harriet', 'Tom', 'Amelia', 'George', 'Poppy', 'Callum', 'Freya'],
}

const LAST: Record<Exclude<Country, 'MY' | 'SG'>, string[]> = {
  US: ['Carter', 'Morrison', 'Chen', 'Reed', 'Brooks', 'Hayes', 'Patel', 'Kim', 'Foster', 'Nguyen'],
  AU: ["O'Connor", 'Nguyen', 'Wilson', 'Taylor', 'Mitchell', 'Harris', 'Walsh', 'Kelly'],
  GB: ['Bennett', 'Clarke', 'Fletcher', 'Hughes', 'Price', 'Ward', 'Shaw', 'Wright'],
}

/** The first and last names to draw one person from; `r` is the seeded random source. */
export function namesFor(c: Country, r: () => number): { first: string[]; last: string[] } {
  if (c !== 'MY' && c !== 'SG') return { first: FIRST[c], last: LAST[c] }
  const groups = c === 'MY' ? MY_GROUPS : SG_GROUPS
  let x = r() * groups.reduce((sum, [, , w]) => sum + w, 0)
  for (const [first, last, w] of groups) if ((x -= w) <= 0) return { first, last }
  return { first: groups[0]![0], last: groups[0]![1] }
}

export interface Place {
  city: string
  state: string
  postal: string
}

/** Real cities with a postcode each really uses, so an address passes the checkout's own rules. */
export const PLACES: Record<Country, Place[]> = {
  MY: [
    { city: 'Kuala Lumpur', state: 'KUL', postal: '50450' },
    { city: 'Kuala Lumpur', state: 'KUL', postal: '59200' },
    { city: 'Kuala Lumpur', state: 'KUL', postal: '55100' },
    { city: 'Petaling Jaya', state: 'SGR', postal: '47301' },
    { city: 'Petaling Jaya', state: 'SGR', postal: '46200' },
    { city: 'Subang Jaya', state: 'SGR', postal: '47500' },
    { city: 'Shah Alam', state: 'SGR', postal: '40000' },
    { city: 'Puchong', state: 'SGR', postal: '47100' },
    { city: 'Cyberjaya', state: 'SGR', postal: '63000' },
    { city: 'Putrajaya', state: 'PJY', postal: '62000' },
    { city: 'Johor Bahru', state: 'JHR', postal: '80000' },
    { city: 'Johor Bahru', state: 'JHR', postal: '81200' },
    { city: 'George Town', state: 'PNG', postal: '10200' },
    { city: 'Bayan Lepas', state: 'PNG', postal: '11900' },
    { city: 'Ipoh', state: 'PRK', postal: '30000' },
    { city: 'Melaka', state: 'MLK', postal: '75000' },
    { city: 'Seremban', state: 'NSN', postal: '70000' },
    { city: 'Kuantan', state: 'PHG', postal: '25000' },
    { city: 'Alor Setar', state: 'KDH', postal: '05000' },
    { city: 'Kuching', state: 'SWK', postal: '93000' },
    { city: 'Kota Kinabalu', state: 'SBH', postal: '88000' },
  ],
  SG: [
    { city: 'Singapore', state: '', postal: '520123' },
    { city: 'Singapore', state: '', postal: '310145' },
    { city: 'Singapore', state: '', postal: '560234' },
    { city: 'Singapore', state: '', postal: '018956' },
    { city: 'Singapore', state: '', postal: '648886' },
  ],
  US: [
    { city: 'San Francisco', state: 'CA', postal: '94107' },
    { city: 'Seattle', state: 'WA', postal: '98101' },
    { city: 'Austin', state: 'TX', postal: '78701' },
    { city: 'New York', state: 'NY', postal: '10001' },
  ],
  AU: [
    { city: 'Sydney', state: 'NSW', postal: '2000' },
    { city: 'Melbourne', state: 'VIC', postal: '3000' },
  ],
  GB: [
    { city: 'London', state: '', postal: 'EC1A 1BB' },
    { city: 'Manchester', state: '', postal: 'M1 1AE' },
  ],
}

const STREETS: Record<Country, string[]> = {
  // Street names found in towns all over Malaysia, so none is in the wrong city.
  MY: [
    'Jalan Mawar', 'Jalan Melati 3', 'Jalan Kenanga 2', 'Jalan Cempaka', 'Jalan Merdeka', 'Jalan Bunga Raya',
    'Jalan Damai 5', 'Jalan Harmoni', 'Jalan Seroja 4', 'Jalan Anggerik', 'Jalan Teratai 1', 'Persiaran Wawasan',
  ],
  SG: ['Tampines Street 11', 'Toa Payoh Lorong 1', 'Ang Mo Kio Avenue 3', 'Marina Boulevard', 'Jurong West Street 64'],
  US: ['Market Street', 'Pine Street', 'Congress Avenue', 'West 34th Street'],
  AU: ['George Street', 'Collins Street'],
  GB: ['Clerkenwell Road', 'Oxford Road'],
}

export function streetLine(c: Country, n: number, street: string): string {
  if (c === 'SG') return `Blk ${100 + (n % 800)} ${street}`
  if (c === 'MY') return n % 3 === 0 ? `${n % 40}-${(n % 12) + 1}, ${street}` : `No. ${n % 90}, ${street}`
  return `${(n % 900) + 10} ${street}`
}

export const streetsFor = (c: Country) => STREETS[c]

export function phoneFor(c: Country, n: number): string {
  const d = String(n).padStart(7, '0').slice(-7)
  if (c === 'MY') return `+60 1${2 + (n % 8)}-${d.slice(0, 3)} ${d.slice(3)}`
  if (c === 'SG') return `+65 9${d.slice(0, 3)} ${d.slice(3)}`
  if (c === 'US') return `+1 415 ${d.slice(0, 3)} ${d.slice(3)}`
  if (c === 'AU') return `+61 4${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(4)}`
  return `+44 7${d.slice(0, 3)} ${d.slice(3)}`
}

/** The currency each country's shopper had the storefront set to. The ledger is USD either way. */
export const DISPLAY_CURRENCY: Record<Country, string> = { MY: 'MYR', SG: 'SGD', US: 'USD', AU: 'USD', GB: 'GBP' }

/** Who delivers where. */
export const CARRIERS: Record<Country, string[]> = {
  MY: ['J&T Express', 'Pos Laju', 'Ninja Van', 'DHL eCommerce', 'City-Link Express'],
  SG: ['Ninja Van', 'SingPost'],
  US: ['DHL Express', 'FedEx'],
  AU: ['DHL Express', 'FedEx'],
  GB: ['DHL Express', 'FedEx'],
}

/* ----------------------------------------------------------------- reviews */

type Aspects = { good: string[]; mixed: string[]; bad: string[] }

const ASPECTS: Record<Kind, Aspects> = {
  phone: {
    good: [
      'The camera is excellent, night shots at a pasar malam came out sharp and natural.',
      'Battery easily lasts a full day with heavy use, usually 30% left at night.',
      'The screen is bright enough to read outdoors at noon.',
      'Fast charging is genuinely fast, 50% in about twenty minutes.',
      'Feels premium in the hand and the speakers are loud and clear.',
      'Smooth and quick, no lag even with lots of apps open.',
    ],
    mixed: [
      'It gets a little warm when gaming for a long time.',
      'A bit heavy, took a week to get used to it.',
      'Portrait mode sometimes cuts around hair badly.',
      'No charger in the box, so budget for one.',
    ],
    bad: [
      'Battery drains much faster than advertised.',
      'The camera struggles indoors and photos look over-processed.',
      'Had random restarts in the first week.',
      'Signal drops in places where my old phone was fine.',
    ],
  },
  earbuds: {
    good: [
      'Noise cancelling is great on the LRT, the rumble just disappears.',
      'Very comfortable, I can wear them for hours at work.',
      'Sound is clear with punchy bass without being muddy.',
      'Pairing with my phone and laptop at the same time works perfectly.',
      'Calls are clear, colleagues say they cannot tell I am on earbuds.',
      'Battery easily lasts my commute for the whole week.',
      'They sit flush in the ear and I forget I am wearing them.',
      'Transparency mode sounds natural, great for crossing the road.',
    ],
    mixed: [
      'The case is a bit bulky for small pockets.',
      'Touch controls are easy to trigger by accident.',
      'Took a while to find the right ear tip size.',
    ],
    bad: [
      'The left bud keeps disconnecting.',
      'Fit is loose and they fall out when I run.',
      'Microphone picks up a lot of wind noise.',
    ],
  },
  headphones: {
    good: [
      'The noise cancelling is superb on flights, I slept through most of KL to Tokyo.',
      'Comfortable for long sessions, no pressure on the head even with glasses.',
      'Sound is detailed and wide, I keep rediscovering old albums.',
      'Battery life is ridiculous, I charge them maybe once a week.',
      'Build quality feels solid and the carry case is well made.',
    ],
    mixed: [
      'They get a bit warm in our weather after an hour or two.',
      'The app is needed for the best sound, which is a little annoying.',
      'Clamping force is strong for the first few days.',
    ],
    bad: [
      'Noise cancelling creates a pressure feeling I could not get used to.',
      'One ear cup started creaking after a month.',
      'Bluetooth cuts out when my phone is in my back pocket.',
    ],
  },
  speaker: {
    good: [
      'Surprisingly big sound for the size, filled our whole living room.',
      'Bass is deep without distorting at high volume.',
      'Battery lasted a whole weekend trip to Port Dickson.',
      'Pairs instantly and the range is good across the house.',
    ],
    mixed: ['A bit heavy to carry around.', 'The app could be better.'],
    bad: ['Crackles at high volume.', 'Stopped charging after two weeks.'],
  },
  music: {
    good: [
      'The build quality is beautiful, every knob feels precise.',
      'Workflow is fun and fast, I finish more ideas than on my laptop.',
      'Recording quality is clean and the built-in mic is better than expected.',
      'Battery lasts for hours of jamming.',
    ],
    mixed: ['There is a learning curve, the manual is worth reading.', 'Pricey, but you get what you pay for.'],
    bad: ['Firmware crashed and I lost a project.', 'Too expensive for what it does.'],
  },
  laptop: {
    good: [
      'The keyboard is a pleasure to type on for long coding sessions.',
      'Battery comfortably gets through a full workday of lectures.',
      'The display is sharp and colour accurate, great for photo editing.',
      'Fast for everything I throw at it, compiles are noticeably quicker.',
      'Light enough to carry around campus every day.',
    ],
    mixed: [
      'Fans spin up under load, audible in a quiet room.',
      'Only two USB-C ports, so I carry a dongle.',
      'The trackpad is huge, sometimes my palm touches it.',
    ],
    bad: [
      'Gets hot on the lap under load.',
      'Battery life is far below what was advertised.',
      'Screen has noticeable backlight bleed.',
    ],
  },
  charger: {
    good: [
      'Charges my laptop and phone at the same time at full speed.',
      'Small enough to throw in any bag, replaced three chargers for me.',
      'Stays cool even when charging everything at once.',
      'Folding pins make it easy to pack for trips.',
      'My MacBook charges as fast as with the original brick.',
      'Finally one charger on my bedside table instead of three.',
      'Build feels solid and the plug fits snugly in the socket.',
    ],
    mixed: ['A little heavier than I expected.', 'No cable in the box, so bring your own.'],
    bad: ['Gets quite hot when charging a laptop.', 'Stopped outputting full power after a month.'],
  },
  powerbank: {
    good: [
      'Tops up my phone several times on a long trip.',
      'Can even charge my laptop in a pinch.',
      'The little display showing the percentage left is really handy.',
      'Recharges itself quickly overnight.',
      'Kept my phone alive through a whole day at a concert.',
      'Two devices at once, no problem.',
      'Slim enough for a jacket pocket.',
    ],
    mixed: ['Quite heavy to carry every day.', 'The cable in the box is short.'],
    bad: ['Loses charge sitting in a drawer for a week.', 'Charging my laptop drains it very fast.'],
  },
  watch: {
    good: [
      'Battery lasts about three days, much better than my old watch.',
      'GPS tracking on runs around Taman Tasik Titiwangsa is spot on.',
      'The screen is very bright and easy to read in the sun.',
      'Comfortable to sleep with, sleep tracking is useful.',
    ],
    mixed: ['It is quite big on a smaller wrist.', 'Pricey compared to the regular model.'],
    bad: ['Heart rate readings jump around during workouts.', 'Strap irritated my skin.'],
  },
  webcam: {
    good: [
      'Picture quality is crisp, colleagues noticed immediately on Teams.',
      'Handles the backlight from my window well.',
      'Plug and play, worked straight away with Zoom.',
    ],
    mixed: ['The clip is a bit fiddly on thin monitors.', 'Autofocus hunts now and then.'],
    bad: ['Image is grainy in the evening.', 'Disconnects randomly on my laptop.'],
  },
  stabiliser: {
    good: [
      'Footage is buttery smooth, even walking through a busy market.',
      'Tiny and quick to set up, I actually take it out now.',
      'Tracking keeps my kids in frame while they run around.',
      'Battery lasts through a full day of shooting.',
    ],
    mixed: ['The app asks to update often.', 'Balancing takes a few tries at first.'],
    bad: ['Motors jitter with a heavier lens.', 'Overheated during a long shoot.'],
  },
  drone: {
    good: [
      'Footage from this is stunning, the sunrise shots over Cameron Highlands look cinematic.',
      'Obstacle sensing gives a lot of confidence to a first-time flyer.',
      'Holds position steadily even with wind at the beach.',
      'Transmission range is excellent, video feed never dropped.',
    ],
    mixed: ['Remember to register with CAAM before flying.', 'Extra batteries are a must, one is never enough.'],
    bad: ['Lost connection twice at short range.', 'Gimbal error after a light landing.'],
  },
  camera: {
    good: [
      'Autofocus is incredibly reliable, eye tracking nails every shot.',
      'Image quality is superb, files have loads of room to edit.',
      'Low light performance is excellent, clean at high ISO.',
      'Compact for a full-frame body, easy to take travelling.',
    ],
    mixed: ['Battery drains quickly when shooting video.', 'Menus take time to learn.'],
    bad: ['Overheats when recording long 4K clips.', 'Grip is too small for my hands.'],
  },
  keyboard: {
    good: [
      'Typing feel is fantastic, crisp and satisfying.',
      'Build is solid, no flex at all.',
      'Wireless connection is stable and battery lasts weeks.',
      'Switching between my laptop and PC takes one keypress.',
      'The keycaps feel premium and the legends are sharp.',
      'Much nicer to type on than my laptop keyboard.',
    ],
    mixed: ['It is loud, my housemate noticed.', 'The software is basic.', 'Quite tall, a wrist rest helps.'],
    bad: ['A couple of keys started double typing.', 'Stabilisers rattle on the space bar.'],
  },
  switches: {
    good: [
      'Smooth and consistent, every switch feels the same.',
      'Fit my hot-swap board perfectly.',
      'The sound is deep and satisfying after lubing a few.',
    ],
    mixed: ['A few pins arrived slightly bent, easy to straighten.', 'Heavier than I expected.'],
    bad: ['Several switches were scratchy out of the box.', 'Two were dead on arrival.'],
  },
  mouse: {
    good: [
      'Very comfortable for long workdays, my wrist feels better.',
      'The scroll wheel is addictive, great for long spreadsheets.',
      'Tracking is precise and the buttons are easy to reach.',
      'Light and fast, perfect for games.',
      'Battery lasts for ages between charges.',
      'Clicks feel crisp and satisfying.',
      'Switching between my laptop and desktop is seamless.',
    ],
    mixed: ['The side buttons take getting used to.', 'Software is needed to remap the buttons.'],
    bad: ['Started double clicking after a few weeks.', 'Too small for my hand.'],
  },
  monitor: {
    good: [
      'Colours and contrast are stunning, blacks are truly black.',
      'High refresh rate makes games feel incredibly smooth.',
      'The stand is sturdy and easy to adjust.',
    ],
    mixed: ['Text has slight colour fringing up close.', 'Takes up a lot of desk space.'],
    bad: ['Arrived with a dead pixel.', 'Brightness drops when the screen is mostly white.'],
  },
}

const OPENERS: Record<number, string[]> = {
  5: [
    'Really happy with this.',
    'Exceeded my expectations.',
    'Best purchase I have made this year.',
    'Love it.',
    'Five stars, no hesitation.',
    'Upgraded from an older model and the difference is huge.',
    'Absolutely worth it.',
  ],
  4: [
    'Very good overall.',
    'Solid, with one or two small gripes.',
    'Happy with it, mostly.',
    'Good buy.',
    'Does the job well.',
    'Pretty impressed.',
    'Nearly perfect.',
    'Good value for what you get.',
  ],
  3: ['It is okay.', 'Decent, but not amazing.', 'Mixed feelings on this one.', 'Fine, nothing special.'],
  2: ['Disappointed.', 'Expected more for the price.', 'Not great.'],
  1: ['Would not buy again.', 'Really poor experience.', 'Very disappointed.'],
}

const CLOSERS: Record<'high' | 'mid' | 'low', string[]> = {
  high: ['Recommended.', 'Would buy from this seller again.', 'Would recommend to friends.', 'No regrets.'],
  mid: ['Still keeping it.', 'Good enough for now.', 'Would consider it on sale.'],
  low: ['Look elsewhere.', 'Hoping a firmware update fixes it.', 'Not worth the money.'],
}

export interface ReviewContext {
  rating: number
  kind: Kind
  city: string
  daysToArrive: number
  payment: string
  /** The shopper returned a damaged unit from this order. */
  damaged: boolean
}

/** A review body, assembled from what happened. `r` is the seeded random source. */
export function reviewBody(c: ReviewContext, r: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const two = (xs: readonly string[]) => {
    const a = pick(xs)
    const rest = xs.filter((x) => x !== a)
    return rest.length ? [a, pick(rest)] : [a]
  }
  const a = ASPECTS[c.kind]
  if (c.damaged) {
    return c.rating <= 2
      ? `${pick(OPENERS[c.rating]!)} Mine arrived damaged and I had to send it back. ${pick(a.bad)}`
      : `First unit arrived damaged, but the seller refunded quickly and without fuss. ${pick(a.good)}`
  }
  // Some people only leave stars, and some only a line.
  if (r() < 0.07) return ''
  if (r() < 0.1) return pick(OPENERS[c.rating]!)

  const parts = [pick(OPENERS[c.rating]!)]
  if (c.rating === 5) parts.push(...two(a.good))
  else if (c.rating === 4) parts.push(pick(a.good), ...(r() < 0.6 ? [pick(a.mixed)] : []))
  else if (c.rating === 3) parts.push(pick(a.mixed), r() < 0.5 ? pick(a.good) : pick(a.bad))
  else parts.push(...two(a.bad))

  if (r() < 0.35) {
    parts.push(
      c.rating >= 4
        ? pick([
            `Delivery to ${c.city} took ${c.daysToArrive} days and it was well packed.`,
            `Arrived in ${c.daysToArrive} days, sealed and genuine.`,
            `Paid with ${c.payment}, checkout was smooth.`,
            'Seller shipped it the next morning.',
          ])
        : pick(['The box arrived a bit dented.', `Took ${c.daysToArrive} days to arrive, longer than I hoped.`]),
    )
  }
  if (r() < 0.45) parts.push(pick(CLOSERS[c.rating >= 4 ? 'high' : c.rating === 3 ? 'mid' : 'low']))
  return parts.join(' ')
}

/** Caught and hidden by the platform's moderators. */
export const SPAM_REVIEWS = [
  'GREAT PRODUCT!!! Cheaper version available, search my shop name on social media for 50% off',
  'Earn RM500 a day from home, message me on Telegram @fastcash_my',
]

/* --------------------------------------------------------------- questions */

export interface QA {
  q: string
  a: string
}

const QUESTIONS: Record<Kind, QA[]> = {
  phone: [
    { q: 'Does it support dual SIM on Malaysian networks?', a: 'Yes, one nano-SIM plus eSIM, and it works on all the major Malaysian networks including 5G.' },
    { q: 'Is a charger included in the box?', a: 'Only a USB-C cable is in the box. Any USB-C PD charger works; the Anker GaN charger we list charges it at full speed.' },
    { q: 'Is this the Malaysian set? Will the warranty work here?', a: 'It is the Malaysian set with a 2-year warranty, claimable at authorised service centres in Malaysia and Singapore.' },
    { q: 'How long does delivery to Sabah usually take?', a: 'Usually 4 to 6 working days to East Malaysia with standard shipping, or 2 to 3 with express.' },
    { q: 'Does it come with a screen protector already applied?', a: 'It has a factory film for shipping only. We recommend a proper tempered glass protector.' },
  ],
  earbuds: [
    { q: 'Can I use just one earbud at a time?', a: 'Yes, either earbud works on its own for music and calls.' },
    { q: 'Will they stay in while running?', a: 'Three tip sizes are included; most customers find the medium tips secure for running.' },
    { q: 'Can they connect to my phone and laptop at the same time?', a: 'Yes, multipoint is supported, so they stay connected to two devices at once.' },
    { q: 'Does the case support wireless charging?', a: 'Yes, the case charges on any Qi pad as well as over USB-C.' },
  ],
  headphones: [
    { q: 'Can I use these with a wire on a plane?', a: 'Yes, a 3.5 mm cable is in the box and works even when the battery is flat.' },
    { q: 'Do they come with a hard case?', a: 'Yes, a hard carry case is included.' },
    { q: 'Are these comfortable with glasses?', a: 'Most customers who wear glasses find them comfortable; the pads are soft and the clamp eases after a few days.' },
    { q: 'How many hours does the battery last with noise cancelling on?', a: 'About 30 hours with noise cancelling on, and a 10 minute charge gives several hours.' },
  ],
  speaker: [
    { q: 'Can I pair two of these for stereo?', a: 'Yes, two units pair as a left and right stereo set in the app.' },
    { q: 'Is it waterproof?', a: 'It is rated for splashes and rain, fine by the pool, but please do not submerge it.' },
  ],
  music: [
    { q: 'Does it work as a USB audio interface?', a: 'Yes, it shows up as a class-compliant audio device on Mac, Windows and iPad.' },
    { q: 'Is the battery replaceable?', a: 'Not by the user, but it is covered by the 2-year warranty and our service centre can replace it.' },
  ],
  laptop: [
    { q: 'Can the RAM be upgraded later?', a: 'The memory is soldered, so please choose the configuration you need at purchase.' },
    { q: 'Is the keyboard US or UK layout?', a: 'US layout, which is the standard layout sold in Malaysia.' },
    { q: 'Can it charge from a USB-C charger?', a: 'Yes, from any USB-C PD charger of 100 W or more, including the Anker GaN charger we sell.' },
    { q: 'Any student discount?', a: 'Not at the moment, but keep an eye on the Deals page, we run promotions at the start of each semester.' },
  ],
  charger: [
    { q: 'Can it charge a laptop and a phone at the same time?', a: 'Yes, the output is shared across the ports and a laptop plus a phone both charge at full speed.' },
    { q: 'Which plug does it come with?', a: 'The Type G (UK) plug used in Malaysia and Singapore.' },
  ],
  powerbank: [
    { q: 'Is it allowed on flights?', a: 'Yes, it is under 100 Wh, which airlines allow in cabin baggage.' },
    { q: 'Can it charge a laptop?', a: 'Yes, any laptop that charges over USB-C, up to the rated output of the power bank.' },
  ],
  watch: [
    { q: 'Does it work with Android phones?', a: 'It needs an iPhone to set up and use.' },
    { q: 'Can I swim with it?', a: 'Yes, it is water resistant for swimming and recreational diving.' },
  ],
  webcam: [
    { q: 'Does it work with Zoom and Teams without drivers?', a: 'Yes, it is plug and play on Windows and macOS; the app is optional.' },
    { q: 'Is there a privacy shutter?', a: 'Yes, a built-in shutter slides over the lens.' },
  ],
  stabiliser: [
    { q: 'How long does the battery last?', a: 'Around 12 hours of continuous use in our testing, depending on the load.' },
    { q: 'Does it work with Android phones?', a: 'Yes, the app is on both Android and iOS.' },
  ],
  drone: [
    { q: 'Do I need to register this drone in Malaysia?', a: 'Drones over 250 g need a permit from CAAM before flying. We include a guide in the box.' },
    { q: 'Does it come with extra batteries?', a: 'One battery is in the box; extra batteries are sold separately.' },
  ],
  camera: [
    { q: 'Is the body weather sealed?', a: 'It is dust and moisture resistant, fine in light rain with a sealed lens.' },
    { q: 'Does it come with a lens?', a: 'Body only. It takes any full-frame E-mount lens.' },
  ],
  keyboard: [
    { q: 'Does it work with Mac?', a: 'Yes, it works with macOS; a couple of media keys need the app to remap.' },
    { q: 'Is it US ANSI layout?', a: 'Yes, US ANSI layout.' },
    { q: 'Can it connect by Bluetooth and by cable?', a: 'Yes, Bluetooth, the 2.4 GHz receiver or a USB-C cable.' },
  ],
  switches: [
    { q: 'Are these 5-pin switches?', a: 'Yes, 5-pin, so they fit both 3-pin and 5-pin hot-swap boards.' },
    { q: 'How many switches are in a set?', a: 'Enough for a full-size board, plus a few spares.' },
  ],
  mouse: [
    { q: 'Is it suitable for left-handed users?', a: 'The shape is right-handed, so we would not recommend it for left-handed use.' },
    { q: 'Does it work on a glass desk?', a: 'It tracks on most surfaces; on glass we recommend a mouse pad for the best accuracy.' },
  ],
  monitor: [
    { q: 'Is burn-in covered by the warranty?', a: 'Yes, OLED burn-in is covered for the full 2-year warranty.' },
    { q: 'Which cables are in the box?', a: 'DisplayPort, HDMI and a USB-C cable are all included.' },
  ],
}

/** Asked about anything. */
const ANY_PRODUCT: QA[] = [
  { q: 'Is this in stock and ready to ship?', a: 'Yes, it ships from our Malaysian warehouse within one working day.' },
  { q: 'What does the warranty cover?', a: 'Two years against manufacturing defects, handled by us directly. Just contact us with your order number.' },
  { q: 'Can I pay by instalments?', a: 'Not yet, but card, FPX and e-wallets are all accepted at checkout.' },
]

export const questionsFor = (k: Kind): QA[] => [...QUESTIONS[k], ...ANY_PRODUCT]

/** Caught and hidden by the platform's moderators. */
export const SPAM_QUESTIONS = ['Selling the same thing much cheaper, WhatsApp me at 012-345 6789 for the price']

/* ----------------------------------------------------------------- returns */

export type Reason = 'damaged' | 'wrong_item' | 'not_as_described' | 'changed_mind' | 'other'

export const RETURN_NOTES: Record<Reason, string[]> = {
  damaged: [
    'Arrived with a deep scratch across the body. Photos attached.',
    'The box was crushed in transit and the unit has a dent on one corner.',
    'It will not power on at all out of the box.',
    'One of the buttons is stuck and does not click.',
  ],
  wrong_item: ['I ordered a different colour from the one I received.', 'Received the wrong model in the box.'],
  not_as_described: [
    'Battery life is nowhere near what the listing says.',
    'Much heavier than the listing made it sound.',
    'The performance is not what was described on the page.',
  ],
  changed_mind: [
    'Found I do not use it as much as I thought I would. Still sealed.',
    'Decided to go with a different model instead.',
    'Bought it as a gift and they already had one.',
  ],
  other: ['Placed a duplicate order by mistake.', 'Ordered two by accident, returning one.'],
}

export const APPROVE_NOTES = [
  'Sorry about that. Refunded in full.',
  'Refund issued. No need to send the packaging back.',
  'Refunded. Thanks for the photos, they made it quick.',
  'Refund approved once the item reached our warehouse.',
]

export const REJECT_NOTES = [
  'The returned unit shows heavy wear and is missing its original accessories, so it is outside our return policy.',
  'Change-of-mind returns need to be unopened; this unit was activated. Contact us if you would like a repair quote.',
  'We could not find the fault described after testing. Please reach out and we will help troubleshoot.',
]
