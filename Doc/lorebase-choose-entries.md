# Choosing entries for LoreBase

This screen is where you tell LoreBase which lorebook entries it decides. Every entry you don't turn on here stays SillyTavern's, and fires by its keys like it always did.

## Before you open it

You open it from VectFox's **WorldInfo** page. In the **LoreBase books** card, **Choose entries** opens the first book of your chat, and the list button on a book's row opens that book.

4 things have to be set first. **Use LoreBase** is on, the **LoreBase model** card has a model, VectFox's embedding model works (**Core** > **Embedding**, the same one your chat memory uses), and SillyTavern's Vector Storage has **Enabled for World Info** off. VectFox asks about that last one when you turn LoreBase on.

## What turning an entry on does

An entry you turn on goes in only when the LoreBase model picks it, and only with the parts of it the next reply needs.

Say your book Harbor Atlas has an entry Lighthouse of Vell, 1,500 tokens, with the key "lighthouse". With SillyTavern's keys, every time someone says "lighthouse", all 1,500 tokens go in. Even when Wren only says "I can see the lighthouse from here".

Turn it on, and its keys stop firing it. Before each reply, the LoreBase model reads the titles of every entry you turned on, next to the last few messages, and picks the ones the reply needs. Then it reads each picked entry and leaves out the parts the reply won't use. So when Keeper Orrin is about to tell the lighthouse's history, the history part goes in. When nobody needs it, nothing goes in.

It's like asking a librarian instead of a search box. The search box gives you every book with "lighthouse" on its cover, whole. The librarian asks what you are working on, and hands you the 2 chapters you need.

On one of my test chats, the keys fired 8 of the entries I gave LoreBase, 5,729 tokens. LoreBase sent 2 of them, cut down to 1,162 tokens.

In the prompt, everything LoreBase sends sits inside one `<VectLorebook>` block, each entry in a tag named after it, like `<Lighthouse_of_Vell>`. So you can tell it apart from SillyTavern's own entries, and so can the AI.

The screen calls the LoreBase model "Luna", since GPT-6 Luna is the model I tested it on.

## Keys and vectors

An entry you turn on takes part only once it has 2 things. Its keys, which the LoreBase model writes, one call per entry. And its vectors, which VectFox's embedding model writes from the entry's title and text.

So when you close this screen with new entries on, VectFox asks to write them, and a progress panel counts them. Until an entry has both, it sends nothing. The entries that are ready keep working meanwhile.

Say "Not now", and LoreBase goes on with the ready ones. It only turns off when no entry is ready at all. **Generate all** on the WorldInfo page writes whatever is missing later.

Each book's row on the WorldInfo page tells you where it stands, like `313 selected, 313 with keys, 300 with vectors`. When all 3 numbers are the same, every selected entry is ready.

Need only one of the 2? **Generate keys** writes just the missing keys, and **Generate vectors** just the missing vectors. Generate vectors never calls the LoreBase model, so it costs almost nothing. It's the one to press after you switch your embedding model.

You don't have to keep them up to date. Edit an entry in World Info, and VectFox writes the vectors of the parts you changed again by itself. Turn an entry off, and its vectors are deleted when you close this screen. Its keys stay, in case you turn it back on.

## Saving them, putting them back, deleting one book

The Database Browser lists every lorebook LoreBase keeps something for, under the type LoreBase. Each book gets a keys row and a vectors row, like `Entries with keys: 313` and `Parts: 504`. So you see what a book holds without opening anything.

Each row has its own Export, Import and Delete. Export saves that one kind to a file. Import puts a file back. Delete removes that kind, of that book, and nothing else. Your selections stay, LoreBase stays on, and those entries just sit out of your replies until Generate keys or Generate vectors writes them again.

This matters MOST for keys. They cost a LoreBase model call for every entry, so a book of 313 entries is 313 calls. Export them once, and after a reinstall, a new PC or a Delete you regret, Import brings them all back with no LLM call at all. Vectors work the same way, and Import puts them back with no embedding call.

Import only writes what still matches. A keys file goes onto an entry only when its number AND its title match, because every book numbers its entries 0, 1, 2. That's what keeps another book's keys off your entries. A vectors file goes onto a part only when that part still has the same text, in an entry you have on.

Before it writes, Import tells you how many it writes, how many of those replace what the book has, and how many it skips. Say Cancel, and nothing changes.

If you switched your embedding model since the export, Import says so, and embeds those parts again with your current model, the same as Generate vectors. To use the saved vectors as they are, switch back to the model the file names first.

A book you deleted from SillyTavern still shows its rows, so you can export or delete what is left. You just can't import into it, since there is no entry left to match. Vectors marked "Not read" are the same kind of leftover: they sit in the other collection from before you switched One shared collection, and LoreBase doesn't read them anymore.

Import a collection, at the top of the list, takes collection files only. Give it a keys or vectors file, and it tells you which row's Import takes it.

## Ticked is NOT on

This is the part that confuses everyone, so I'll say it first. Each entry row has 2 controls, and they do different things.

- The **wand button** on the right of the row turns LoreBase on or off for that entry. Pressed means on. It saves right away.
- The **checkbox** on the left only ticks the row. A tick does nothing on its own. It's a mark for the **Turn on** and **Turn off** buttons above the list, so you can change many entries at once.

It works like the checkboxes in your email inbox. Ticking 20 emails doesn't delete anything. Pressing Delete does.

2 pills tell them apart. The **selected** pill at the top right counts the entries that are on. The **ticked** pill above the list counts your ticks.

Ticks are never saved. They go away when you switch to another book or close the screen. Everything else saves as you click it: the wands, Turn on and Turn off, the locks and the pins.

## The lock: where LoreBase decides

Turning entries on says WHICH entries LoreBase decides. Locking the book says WHERE. LoreBase decides a book's entries only in a chat, or with a character, the book is locked to. Everywhere else the whole book fires by its keys, and your selection just waits.

- **Lock to this chat**: LoreBase decides this book's entries in the chat you have open.
- **Lock to this character**: the same in every chat with this character.

You don't have to lock the chat yourself. Once LoreBase writes the keys of the entries you turned on, it locks their book to the chat you have open. That's when you close this screen and press **Write keys and vectors**, turn on **Use LoreBase**, or press **Generate all**. The line under Generate all tells you, like `Locked "Harbor Atlas" to this chat.`

A book already locked to this chat or this character stays as it is. And if you changed a lock on this screen, closing it keeps your choice, so a lock you turned off there stays off. Locking to the character is always your call.

So you can turn on 50 entries in Harbor Atlas in your Wren chat to try them. Only that chat changes, your other chats don't. If you like it, lock it to the character too.

A group chat has no one character, so its character lock can't be turned on. With no chat open, neither lock can.

## Finding entries: the book and the filters

The dropdown at the top lists every lorebook in SillyTavern. The books your open chat loads come first, marked "(this chat)", then the rest by name. A book with entries on says how many, like "Harbor Atlas (this chat), 12 selected".

The row under the locks narrows the list. Filters only change what you see. They never turn anything on or off, and they stay as you set them until you close the screen.

| Filter | What it shows |
|---|---|
| Search | Entries with every word you type somewhere in their title, keys or text. Case doesn't matter. |
| Any size | Only entries of at least 300, 1,000 or 3,000 tokens. |
| Any keys | Only entries with keys, or only those without. |
| Any badge | Only entries with one badge. The badges are explained below. |
| All entries | Pick "New since last opened" to see only the entries added to the book since you last opened it here. |

## Categories

LoreBase reads a category from the start of an entry's title in World Info. "[Places] Lighthouse of Vell" is in the category [Places], with the title "Lighthouse of Vell". A title starting with 【…】, or with a short word and a colon like "People:", works too. Entries with none are under **No category**, at the bottom.

Each category row says how many entries it has and how many are on, with a pill: **Off** when none is on, **Some on**, or **All on**.

- The **filter button** shows only that category's entries in the list. **All categories**, at the top, shows them all again.
- The **wand button** turns LoreBase on for every entry in the category. On an All on category it does the opposite, and turns the whole category off, any engine entry you turned on by hand included.

The category's wand skips engine entries (see the pills below), and entries SillyTavern keeps. You turn engine entries on one by one. So a category of nothing but those has its wand greyed out.

Nothing is saved per category. An entry you add to [Places] later shows up off, with a New pill, so you decide on it yourself.

## Pinned sections

Big entries get cut into parts by their headings, like a character entry with Appearance, History and Speech Style. Those headings are the sections. LoreBase sends the parts the reply needs, so sometimes Speech Style is left out.

If a section should ALWAYS go in when its entry is picked, tick it under **Pinned sections**. Pin Speech Style, and every picked entry with a Speech Style section brings it along, no matter what the LoreBase model said.

The list shows the section names in the entries you turned on, the most common first, each with how many entries hold it. It stays empty until you turn on an entry with sections. Pins are per book.

## The entries list

Each row shows the entry's title, its category, its size in tokens, how many keys it has, and its pills.

The buttons above the list work on your ticks:

- **Tick all matching** ticks every entry your filters show, even the ones further down that the list hasn't drawn yet. It skips engine entries and the ones SillyTavern keeps.
- **Untick all** clears every tick.
- **Invert** flips the tick of every entry your filters show. It never ticks an engine entry, or one SillyTavern keeps.
- **Turn on** and **Turn off** turn LoreBase on or off for every ticked entry.

Hold Shift and click a checkbox, and every row between it and the last one you clicked gets the same tick.

One thing to watch. A tick stays when a filter hides its row. If you tick 10 entries in [Places], then show [People] and press Turn on, the 10 in [Places] are turned on too. The ticked pill always counts them all. When in doubt, press Untick all first.

The list draws 100 entries at a time. **Show more** draws the next 100.

At the bottom, a line says how many titles the LoreBase model reads from this book, and about how many tokens that adds to every pick. Every entry you turn on is one more title it reads before every single reply.

## The pills on a row

Some pills say why an entry can't be turned on. The rest are there to help you choose.

| Pill | What it means |
|---|---|
| Constant, Sticky, Cooldown | SillyTavern keeps this entry. A constant entry always goes in, and sticky and cooldown timers only work when SillyTavern fires the entry itself. So it can't be turned on, and it can't be ticked. If it was on before it became one, you can still turn it off. |
| `@@activate`, `@@dont_activate` | SillyTavern keeps this entry too. That line at the top of the entry tells SillyTavern to send it on every reply, or never, and SillyTavern follows it whatever LoreBase sends. So it can't be turned on, and it can't be ticked. If it was on before the line was added, you can still turn it off. |
| Disabled | Turned off in World Info. You can turn it on here, but LoreBase skips it until you enable it again. |
| New | Added to the book since you last opened it on this screen. The first time you open a book, nothing is new. |
| Template code | Has template code, like `<% %>` blocks. When picked, it goes in whole, never cut. |
| Mostly code | At least half of it is template code. |
| Engine | A game engine's entry, like MVU's state entries. |
| Code keys | Every key looks like a code, such as `#0765792`, not a word. |
| No keys | Fine for LoreBase, the pick doesn't need keys. Turned on, LoreBase can even send an entry no key ever fired. |
| Long | 1,000 tokens or more. This is where LoreBase saves the most, since it leaves out the parts of a long entry the reply doesn't need. |
| No title | The LoreBase model picks by title, so an entry with no title is never picked. Give it a title in World Info first. |

Engine, Code keys and Mostly code are what I call engine entries. They drive a game rather than tell lore, so Tick all matching, Invert and a category's wand skip them. You can still turn one on with its own wand, or tick it by hand.

## How I choose entries

I go through a book in the same order every time. Even a book of 300+ entries is quick, because you mostly click categories, not entries.

**1. Start with the categories.** The author already sorted the book for you. Ask each category one question: does a reply need this only when the story is about it? Characters, places, monsters, items, magic, history, that's lore. Turn the whole category on with its wand.

**2. Leave the rules to SillyTavern.** World rules, writing style, the card's setting... every reply must follow those, whatever the scene is about. Most of them are constant anyway, so the screen won't even let you turn them on. Engine entries stay SillyTavern's too, which is why the category wands skip them.

**3. Go through No category by hand.** Authors park their odd entries there: credits, dividers, rules, and lore they never sorted. Turn on the lore. Leave the dividers off, and anything with 0 tokens. An empty entry has nothing to send, but the LoreBase model still reads its title, and it may pick it and waste a call on it.

**4. Leave the big overviews to SillyTavern.** Some books have an overview for each topic, like one entry that explains how all the magic works. The LoreBase model picks the specific entries instead, so it almost never picks an overview. In my test, the magic overview wasn't picked once in 12 replies, even when the whole scene was a lesson about magic, and even after I gave it a clear title. If your story needs those overviews, leave them to SillyTavern.

**5. Leave the main character to SillyTavern.** I mean the one every reply is about, usually the one you play. Their sheet is needed in most replies, so it works like a rule. In my test the main character's sheet was needed in 7 of 12 replies, and LoreBase picked it in only 2 of those.

**6. Turn on the small ones too.** Monster and item entries are often 100 tokens or so, but their keys are common words like "King" or "dog". With keys, they ride along on lots of replies just because someone said the word. Turned on, they go in only when the scene is about them. Each one costs a title on every pick, about 4 tokens, and the line at the bottom of the screen adds them up for you.

**7. Try it on one chat first.** Writing the keys locks the book to the chat you're in, and only that one. Play 10 replies or so there, and open the **LoreBase tester** card on the WorldInfo page. It shows what was picked and why, which parts went in, and the tokens next to what SillyTavern's keys would have sent. Happy with it? Lock the book to the character too.

## What to expect

LoreBase is picky. On my test book, with 311 of its 320 entries turned on, SillyTavern's keys would have sent 12,000 to 35,000 tokens of those entries on every reply, and only about a quarter of it was useful. LoreBase sent 700 to 2,300 tokens, and almost all of it was useful.

But picky cuts both ways. LoreBase sends what it is sure the next reply needs, and sometimes it leaves out something that would have helped, most often when a scene has many people or many topics at once. So if a reply forgets something, open the tester card and look. If LoreBase left that entry out, you can leave it to SillyTavern.

If you play in another language than your book, like Chinese against an English book, turn on more. Keys miss across languages, the LoreBase model doesn't.

Basically, turn on the lore, leave the rules, the overviews and the main character to SillyTavern, and let the LoreBase model decide what goes in. Everything you don't turn on keeps working the old way.


##  how lowerbase works now

**Today: how LoreBase works now**

On each reply, Luna works in two steps:
1. **Pick.** Luna sees one line per entry, a number and the title only, and picks up to 6 entries:
   ```
   12. battle
   ```
2. **Review.** For each picked entry, Luna reads its text, cut into numbered parts, and says which parts the reply doesn't need. The parts come from VectFox's splitter: the author's own headings, otherwise windows of about 300 tokens. Only the kept parts are sent.

"Today asked again" is the same thing run a second time, to show how much the numbers move from luck alone.


