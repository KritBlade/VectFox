# Entity-Lore

Entity-Lore writes a lorebook entry for every named character in your story, all by itself. It reads what StoryArc already knows about them, and LoreBase puts the entry in when a reply needs it.

## What it does

StoryArc already counts how many events name each person, on its **Entity** tab. Entity-Lore turns that count into lore. Once a character shows up in 10 events, LoreBase's model writes an entry about them from those events.

Say your story has an innkeeper called Mira. Around her 10th event, she gets an entry: who she is, how she acts, her past, the turning points of her story, and who she's tied to. 300 replies later, Wren walks back into her inn, and LoreBase hands the AI Mira's entry. So she still knows he never paid for that room...

It's like a game master's notes on every NPC the players ever met. Nobody remembers the innkeeper's name 3 sessions later. The notes do.

The entries go in a book of their own, `VectFox NPCs - <your chat's name>`, and that book is added to this chat only. Another chat with the same character card never loads it. That's on purpose. 2 stories with the same card can each have their own Mira.

LoreBase writes each entry's keys and vectors and turns the entry on for this chat, the same as for any book you give it. So the entry goes in only when LoreBase picks it for a reply, not every time someone says "Mira". How LoreBase picks is in [LoreBase](lorebase.md).

## What goes in an entry

An entry is a profile of the character, not a summary of the story. It has 5 sections:

- **[Identity]**: who they are, their full name and other names, their role, what they are to the story.
- **[Personality]**: how they think, act and talk, what they want and what they fear.
- **[Background]**: what happened to them before the story, and why, as the latest events tell it.
- **[Key events]**: the turning points of their story, oldest first, one event per line.
- **[Relationships]**: each character they're tied to, how that tie came about, and how it stands now.

It's written in your story's language, with the headings in English. At most 600 words, and at most 15 key events.

What never goes in: where they are right now, what they wear, how they look or feel at the moment. That changes every scene. An entry that says "Mira is angry" keeps saying it long after she calmed down. Tracking that is a job for a state tracker like MVU, not for a lorebook.

## Who gets an entry

Only named characters. Before Entity-Lore writes anyone new, LoreBase's model checks the new names. Mira and Captain Reyes get an entry. "The guard" and "a waitress" don't. Those are roles, not names.

The check also catches 1 person under 2 names. If your story says both "Reyes" and "Captain Reyes", that's 1 entry, keyed by both. And if a name belongs to someone who is already in one of the chat's lorebooks, it links the name to that entry instead of writing a second one.

Some names never even get to the check: the chat's character (or a group chat's members), your persona, anyone whose name is already a title or key in one of the chat's lorebooks, and names in the character card's description. They're covered already, so their rows just say why.

## Keeping it up to date

Stories move on. So every 30 more events that name a character, their entry catches up. LoreBase's model gets the entry as it stands, plus ONLY the events since its last write, and writes the entry again, whole. The old key events stay, and the new ones get added.

Why not rewrite it from the whole story every time? Because a rewrite reads every event of that character, every single time, and that adds up fast. On my longest test story, the main character is in 1,600+ events. Rewriting every entry every 30 events, from the start of that story, would read about 9 million tokens, and almost all of it is that one character read over and over again. Catching up reads about 0.6 million tokens. Same entries, about 15 times less.

A full rewrite still happens when a character's names change. You merge 2 names on StoryArc's **Entity** tab, you split a name off and choose **Write again**, or the name check finds out a new name is someone who already has an entry. Then the entry needs the events of every name, so it reads the whole story. And you can always press **Rewrite now** yourself.

## The Entity-Lore tab

Everything is on VectFox's **WorldInfo** page, on the **Entity-Lore** tab.

- **Use Entity-Lore** turns it on. It's off by default, and it needs StoryArc mode and **Use LoreBase**. This switch is for ALL your chats, not just the one you have open. When you turn it on and something is due, it asks Run now's question right away.
- **Write at** (10 events by default, 3 to 50): a named character gets an entry once this many events name them.
- **Catch up every** (30 events by default, 10 to 100): after this many more events, their entry catches up.
- **Run now** writes, catches up and rewrites every entry that's due. It asks first, with how many of each, and the question opens on **Cancel**, because yes costs calls.

Under that is the list of characters, 1 row each. The row says where they stand, and its buttons are what you can do about it.

| The row says | What it means | Buttons |
|---|---|---|
| Waiting, 4 of 10 events | Not enough events yet | Lock |
| Due | Gets an entry at the next run | Write now, Lock |
| Written at 12 events | Has an entry, up to date | Open entry, Catch up now, Rewrite now, Lock |
| Catch-up due | 30 more events since its last write | Open entry, Catch up now, Rewrite now, Lock |
| Rewrite due | Its names changed, so the next run rewrites it | Open entry, Rewrite now, Lock |
| Edited by you | You changed the entry by hand | Open entry, Catch up anyway, Rewrite anyway, Lock |
| Deleted by you | You deleted the entry in SillyTavern | Allow again |
| Not a named character | The name check called it a role | Allow again |
| Same as Captain Reyes | Another name of a character who has an entry | Allow again |
| Already in a lorebook | The character is in one of the chat's lorebooks | Allow again, when the name check linked it |
| This chat's character, Your persona, In the character card | Left out on purpose | none |
| Locked | Entity-Lore leaves this character alone | Open entry, when there is one, and Lock |

**Open entry** opens the entry in LoreBase's editor. **Allow again** takes back what happened to that name. On **Deleted by you**, the entry gets written again. On a name the check turned down, the next run asks about it again. On a **Same as** row, it also keeps the 2 names apart for good, so the check won't match them again.

## Your edits win

If you edit an entry by hand, Entity-Lore never catches it up or rewrites it on its own again. Its row says **Edited by you**. **Catch up anyway** and **Rewrite anyway** are there for when you want it to, and each one asks first.

If you delete an entry in SillyTavern, it stays deleted. Its row says **Deleted by you**, and nothing writes it again until you press **Allow again**.

**Lock** is for a character you don't want touched at all. Like your main heroine, whose entry you wrote yourself. A locked character gets no entry, no catch-up and no rewrite, so no calls either. The padlock shows which way it is: open and green while Entity-Lore writes them, closed while they're locked. Press it again to unlock.

## How many LLM calls it makes

All of them go to LoreBase's model, the one in the **LoreBase model** card on the **Main** tab.

Every entry costs 2 calls. One writes the entry. The second writes the keys LoreBase uses to find that entry later. Think of a library. Putting a book on the shelf is one job, and writing its card in the catalog is another. Skip the card and nobody finds the book.

That's also why the keys get written again every time the entry does, on a catch-up and a rewrite too. The keys always come from what the entry says now, so they never point at an older version of it.

**New characters.** Before any new entry, 1 call checks all the new names at once, no matter how many there are. When the chat's other lorebooks have keys, a second call checks the names that passed against those keys, so someone you already have under another name doesn't get a second entry. Then each new entry is 2 calls.

So 10 new characters with **Run now** is 1 + 10 × 2 = 21 calls, or 22 when that second check runs.

On its own, after an EventBase run, Entity-Lore writes at most 5 entries, so a busy chat never fires 20 calls at once. That means the same 10 characters take 2 runs: 1 + 5 × 2 = 11 calls each, 22 in all. The first run checks all 10 names but only writes 5 of them, so the other 5 get checked again in the second run.

A name the check turns down costs nothing more. No entry, no calls.

**Catching up.** 2 calls per character, every 30 more events that name them. No name check. If Mira, Reyes and Wren each pass 30 new events, that's 3 × 2 = 6 calls.

**Rewriting.** 2 calls too. It reads the whole story instead of the new part, so each call is bigger.

**Long stories.** A character with more than about 30,000 tokens of events takes a few more calls for a first entry or a rewrite. Entity-Lore takes notes on each part of about 30,000 tokens first, 1 call per part, then writes the entry from the notes. A catch-up of 30 events never gets that big.

**What costs nothing.** A locked character. An entry you edited or deleted, until you press a button on its row. A catch-up with no new events to read. And every name that's left out before the check.

To give you a feel for the size, here are real numbers from one of my test stories, on GPT-6 Luna, both calls together:

| Write | Calls | Tokens in | Tokens out |
|---|---|---|---|
| First entry, from 8 events | 2 | about 2,200 | about 1,300 |
| Catch-up, 3 new events | 2 | about 2,900 | about 1,700 |
| Rewrite of a character with 103 events | 2 | about 16,300 | about 3,000 |

Tokens out include the model's thinking. Each event in that story is about 100 tokens, so a catch-up of 30 events reads about 3,000 tokens more than the one above.

Each write also sends the entry to your embedding model for its vectors. That's not an LLM call. It's the same cheap embedding LoreBase does for every entry you turn on.

## When it runs

After every EventBase run that adds events to this chat, Entity-Lore runs on its own: new entries first, then rewrites, then catch-ups, at most 5 of them. **Run now** does everything that's due, after asking. And a row's buttons do just that one character.

The progress panel shows each entry as it goes, like `Catching up Mira, 1 of 3`, and ends on what the run did. It writes up to 3 entries at the same time, and **Stop** ends the run once the ones it already started are done.

## Before you turn it on

A few things have to be on first:

- StoryArc mode, on the **StoryArc** page.
- **Use LoreBase**, with everything LoreBase needs: Qdrant, a working embedding model, and a model in the **LoreBase model** card. [LoreBase](lorebase.md) has the full list.

If something is missing, the card says **Entity-Lore is paused**, with a button that takes you to where you fix it.

When you turn LoreBase off, Entity-Lore stops too. Its book doesn't load either, because it belongs to LoreBase, like every book you add to a chat through LoreBase.

Basically, every character that matters gets a page of notes that keeps up with your story, 2 calls at a time, and you decide which ones it's allowed to touch.
