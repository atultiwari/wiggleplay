# Learning Games for Toddlers (2.5–3 yrs) — Idea Catalogue

Goal: if screen time cannot be reduced, make it interactive and educational.
Every idea below follows the same ground rules.

## Ground rules for every project

- One action per screen, huge targets, generous hit detection. A near miss still counts.
- A single friendly character does all talking through voice. Text on screen is only for parents.
- No fail states. Every interaction produces an immediate sound + animation reward.
- Sessions are 3–5 minutes with a built-in "bye bye" ritual so ending feels normal.
- Parent gate for settings, no links, no ads, works offline, landscape tablet first.
- Every activity emits skill events (e.g. "tapped red correctly in 1.2s") that feed the adaptive AI layer.

---

## Category A — Touch based (tablet, finger only)

### A1. Sound and colour play

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 1 | Musical finger paint | Drag to paint; each colour is an instrument. Shake to clear, mirror mode for symmetry. | Colours, cause & effect, fine motor |
| 2 | Tap the farm | Tap animals to animate and hear sounds. Voice then asks "where is the cow?" | Animal names, sounds, listening vocabulary |
| 3 | Bubble pop counting | Pop floating bubbles; voice counts each pop. Grows 1→3→5→10. | Counting, number words |

### A2. Sorting and matching

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 4 | Colour buckets | Drag balls into matching buckets; balls snap from far away. | Colour matching |
| 5 | Shape peg puzzle | Fit circle, square, triangle; more shapes unlock with mastery. | Shapes, spatial reasoning |
| 6 | Feed the monster | Drag food to a monster who names the colour and food. | Vocabulary, colours, later fruits/veg/sizes |

### A3. Turning passive video into interaction

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 7 | Tap-along rhymes | "Wheels on the Bus" only advances when the child taps the wheels. | Cause & effect, rhythm |
| 8 | Checkpoint cartoons | Short clip plays, pauses with one big question ("which one is the dog?"). | Comprehension, vocabulary |
| 9 | Personal cartoon episodes | AI-generated 30s clips featuring the child's name, toys, pet, with a tap beat. | Engagement, self-recognition |

### A4. Early concepts

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 10 | Peekaboo boxes | Tap a box or curtain to reveal an animal. | Anticipation, object permanence |
| 11 | Dress the bear | Drag hat to head, socks to feet; voice names each body part. | Body parts, clothing |
| 12 | Bedtime routine game | Brush teeth, pyjamas, lights off. Real pre-sleep wind-down. | Routines, sequencing |
| 13 | AI colouring book | Parent says "dinosaur on a bicycle"; app generates thick-line SVG to finger-paint. | Colours, creativity |

---

## Category B — Keyboard and mouse free (camera, voice, motion)

### B1. Camera and body movement  ← FIRST BUILD TARGET

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 14 | Simon Says mirror | Pose tracking checks "touch your nose", "jump", "clap", "arms up". | Body parts, listening, gross motor |
| 15 | **Air painting** | Index finger paints in the air; screen shows the trail. | Fine motor, colours, creativity |
| 16 | **Catch the stars** | Step left/right (or move hand) to catch falling stars with an avatar. | Gross motor, tracking, counting |
| 17 | **Wave to pop** | Bubbles drift across the camera feed; any hand movement pops them. | Cause & effect, gross motor |
| 18 | **Fruit slice (Fruit Ninja style)** | Swipe hand through the air to slice flying fruit; voice names each fruit and colour. | Fruit names, colours, hand-eye coordination |
| 19 | Dance and freeze | Music plays, child dances, smiley appears when they freeze on time. | Listening, self-control, rhythm |
| 20 | Emotion mirror | Child makes a happy/sad/surprised face; a cartoon animal copies it. | Emotional vocabulary |
| 21 | Show me something red | Child holds up any object; camera confirms the colour. Works for shapes and finger counting. | Colours, shapes, numbers |
| 22 | Toy show and tell | Child holds up a toy; character names it in English and home language. | Vocabulary, bilingual words |

### B2. Voice and microphone

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 23 | Animal call and response | "What does the cow say?" Any moo (volume/pitch only) makes the cow dance. | Animal sounds, speaking confidence |
| 24 | Say the colour | Big colour appears, child says the word; lenient matching. | Colour words, speech |
| 25 | Blow to play | Blow into the mic to spin a windmill, blow out candles, push a sailboat. | Breath control, counting |
| 26 | Clap counter | Character claps N times, child claps back, screen counts along. | Counting, imitation |
| 27 | Sing to fly | Louder singing lifts a balloon higher during a nursery rhyme. | Singing, volume control |
| 28 | Choose your story | AI narrates a story about the child's favourites and pauses with two spoken options. | Listening, decision making, vocabulary |

### B3. Tablet motion sensors

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 29 | Tilt marble maze | Tilt the tablet to roll a ball into a hole; three ball colours. | Motor control, colours |
| 30 | Shake the tree | Shake the device, apples fall, voice counts them. | Counting, cause & effect |
| 31 | Rock the baby | Gentle rocking puts a cartoon baby to sleep. | Calm, slow movement, empathy |

### B4. Physical-world hybrids (less screen focus)

| # | Project | What the child does | What they learn |
|---|---------|---------------------|-----------------|
| 32 | Printable flashcards + scanner | Print colour/animal cards; child shows them to the camera for a sound reward. | Colours, animals, real-object link |
| 33 | Block counter | Point camera at wooden blocks on the floor; screen counts them. | Counting real objects |
| 34 | Room scavenger hunt | "Find something blue in the room." Child fetches it; camera confirms. | Colours, movement, memory |

---

## Cross-cutting: AI adaptive layer

- **Skill graph per child**: colours, shapes, numbers 1–10, animals, body parts, first words.
- Every activity reports accuracy and response time per item.
- An LLM (Claude) decides the next activity, number of choices shown, and items to repeat.
- It also generates fresh prompts, story text and outline art so content never runs dry.
- **Parent summary** reads like: "knows red and blue, mixing up triangle and square".
- **Bilingual mode**: English + home language labels, switchable per activity.
- **Session pacing**: gentle wind-down, consistent "bye-bye" ritual, parent-set timer.

## Safety constraints

- The child never chats openly with an AI. Generated content passes through fixed templates and a word list.
- Camera and audio are processed on device where possible.
- Nothing leaves the device unless a parent explicitly enables it.
- No external links, no ads, no in-app purchases visible to the child.

## Suggested tech

- One web app (PWA) using canvas/SVG for visuals.
- MediaPipe (hands, pose, face) running in the browser.
- Web Speech API for TTS and simple recognition; on-device Whisper as an upgrade.
- Claude API on a small server for content generation, cached aggressively.
- Static hosting (GitHub Pages / Netlify / Vercel).

## Roadmap

1. **Shared kit**: big-button engine, character voice, reward animations, skill tracker.
2. **Phase 1 (camera games)**: Air painting, Catch the stars, Wave to pop, Fruit slice.
3. **Phase 2**: Tap the farm, Simon Says mirror, Tap-along rhymes.
4. **Phase 3**: voice games, motion-sensor games, AI adaptive layer, parent dashboard.
5. **Phase 4**: more age bands (3–4, 4–5) and interest-based filtering.
