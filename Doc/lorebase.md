# LoreBase

LoreBase picks the lorebook entries each reply needs, instead of letting their keys fire them. You choose which entries it decides. Every entry you don't give it stays SillyTavern's, and fires by its keys like it always did.

## What it does

A key only knows a word. SillyTavern fires an entry whenever one of its keys shows up in the chat, whether the scene is about it or not.

Say your book Harbor Atlas has an entry Lighthouse of Vell, 1,500 tokens, with the key "lighthouse". Every time someone says "lighthouse", all 1,500 tokens go in. Even when Wren only says "I can see the lighthouse from here".

Give that entry to LoreBase, and its keys stop firing it. Before each reply, LoreBase reads the last few messages and picks the entries the reply needs. So when Keeper Orrin is about to tell the lighthouse's history, Lighthouse of Vell goes in, and on High Accuracy only its history part. When nobody needs it, nothing goes in.

It's like asking a librarian instead of a search box. The search box gives you every book with "lighthouse" on its cover, whole. The librarian asks what you are working on, and hands you the 2 books you need.

On one of my test chats, the keys fired 8 of the entries I gave LoreBase, 5,729 tokens. LoreBase sent 2 of them, cut down to 1,162 tokens.

In the prompt, everything LoreBase sends sits inside a `<VectLorebook>` block, each entry in a tag named after it, like `<Lighthouse_of_Vell>`. So you can tell it apart from SillyTavern's own entries, and so can the AI. The block goes where those entries would go by their World Info position, and picks set to different positions get a block each.

Everything is on VectFox's **WorldInfo** page. The **Main** tab has the **LoreBase books** card, for your books and their entries, and the **LoreBase model** card, for how it picks. The **LoreBase tester** tab shows what it did on each reply.

## How it picks

You choose how on the **LoreBase model** card, under **Accuracy**: **Fast and Cheap [Jev]**, the default, or **High Accuracy**.

Think of the librarian from before, working 2 different ways. On High Accuracy, the librarian goes down the list of titles, takes the books you need off the shelf, and reads them, so you only get the chapters you need. On Fast and Cheap, an assistant goes down the same list asking "does this one help?", and hands you the likely books whole, the best first, until your bag is full.

Both start the same way, before every send, swipe, regenerate and continue. Never on impersonate. LoreBase reads the scene, which is the last 6 messages, up to and including yours. Hidden messages are skipped, and each one goes through your **Text Cleaning** first, with the AI's thinking and any game-system blocks taken out.

Then it gathers the entries you turned on that are ready, with their keys and vectors. The rest sit out, and a toast tells you how many, once per chat and again when that number changes.

### Fast and Cheap [Jev]

Jev is a small model that only answers yes or no questions, with how sure it is. It answers in under a second, for a fraction of what a normal model costs. It runs on a profile of its own, in the model card's **Jev** group: an OpenRouter one with `typesafe/jev-1.14`, or a Custom one on Typesafe's own URL with `jev-1.14.0`.

1. **The search, only above 100 entries.** When the books locked here have more than 100 ready entries in all, a search narrows them down to 100 first. It searches with your last message and the one before it, usually the AI's last reply, both in 1 request to your embedding model. An entry scores by its best part, and the 100 best stay. With 100 entries or fewer, there's no search, and Jev gets all of them.
2. **Jev's questions.** Jev reads the scene, and one question per entry, made from its title and its keys:
   ```
   Does the next reply need the lorebook entry "Lighthouse of Vell" (about: lighthouse, Vell, keeper)?
   ```
   It answers every question with its chance of yes, from 0 to 1, all in 1 call.
3. **The cut.** Every entry Jev rates above 0.25 is a candidate. The rest are out.
4. **The lore budget.** The candidates go in WHOLE, the best first, with no review, until the lore budget is full. That's 4,000 tokens by default, and **Lore budget** in the Jev group takes 1,000 to 12,000 tokens. The best one always goes in, even when it's bigger than the budget. After that, an entry that doesn't fit is skipped, and the next one gets its turn.

Say Jev rated these 4 above 0.25, with the budget at 3,000 tokens:

| Entry | Jev's rating | Size | What happens |
|---|---|---|---|
| Lighthouse of Vell | 0.9 | 1,200 tokens | Goes in, 1,200 tokens so far |
| Keeper Orrin | 0.7 | 900 tokens | Goes in, 2,100 tokens so far |
| Harbor Tides | 0.4 | 1,500 tokens | Skipped, it would make 3,600 tokens |
| Vell Market | 0.3 | 400 tokens | Goes in, 2,500 tokens in all |

### High Accuracy

On High Accuracy, the LoreBase model does 2 jobs. It picks the entries, and then it reads them.

1. **The pick.** The LoreBase model reads a list of every ready entry, one line each, with its number, its title and the keys it wrote for it:
   ```
   12. Lighthouse of Vell (lighthouse, Vell, keeper)
   ```
   Next to the scene, it picks the entries the next reply needs, most needed first, or none. It picks at most the **Pick limit** on the model card: 6 entries by default, and it takes 1 to 12 entries. For each one it says why, and what in it the reply needs.
2. **The cache.** The list sits at the very end of the pick's system prompt, and it's the exact same text every reply, until your selection, a title or the keys change. So after the first reply, a provider that caches reads it from its cache, which costs way less. The Pick limit isn't in that part, so changing it keeps the cache. The **LoreBase tester** shows how much it saves, like `Pick read from the cache: 10,141 of the pick's 15,070 prompt tokens`.
3. **The reviews.** Then the LoreBase model reads each picked entry, 1 call per entry, all at the same time. It gets the entry cut into numbered parts: by the author's own headings first, and into pieces of about 300 tokens where a section is still too long. It says how much of the entry the reply will use, "most", "some" or "none", and which parts are of no use right now. An entry of only 1 part, or one with template code, skips its review and goes in whole.
4. **What it sends.** Every part the review didn't leave out, in the entry's own order, plus every part of a pinned section. An entry the review says the reply uses none of sends nothing.

High Accuracy never searches, so it never uses the vectors. Every entry still needs them, though, so you can switch between the 2 any time and no entry drops out.

### When a call fails

The reply goes on without that lore, and a toast tells you what happened. A failed search, Jev call or pick leaves out every entry you turned on, for that reply. A failed review leaves out only its own entry. Jev and the LoreBase model get 30 seconds to answer each call, and regenerating the message tries again.

### Which one to choose

On my test book of 313 entries, Fast and Cheap cost about $0.0004 a reply, and the whole step took about 1.8 seconds. The search was 1.3 seconds of that. High Accuracy, at its default Pick limit of 6 entries, cost about $0.0018 a reply once the cache kicked in, and the reply waited about 7 seconds for its pick and reviews.

But High Accuracy sends way less, since it cuts entries down to what the reply needs. On that book it sent about 1,400 lore tokens a reply, where Fast and Cheap sent about 3,000 lore tokens. Your chat model reads every one of those tokens. So with a chat model of $1 per million input tokens or more, High Accuracy came out the cheaper one in all.

So, Fast and Cheap is the quick one, and it costs about the same on a small book or a huge one. High Accuracy is slower, but it cuts long entries down, so your prompt stays lean.

## How many LLM calls it makes

There are 2 kinds. The calls that get an entry ready, which happen once. And the calls on every reply.

**Getting an entry ready.** Every entry you turn on needs keys, and the LoreBase model writes them, 1 call per entry. Those are the keys the pick reads next to each title, and the words in Jev's questions. It happens once. A book of 313 entries is 313 calls, and then never again for those entries. If an answer comes back broken, it asks again, up to 3 times in all.

LoreBase writes its own keys from the entry's text, so every entry gets the same kind of list: the people, places, things and events it holds. It doesn't need the author's keys at all, so an entry with none works just as well.

Its vectors come from VectFox's embedding model, the same one your chat memory uses. That's not an LLM call, and it costs almost nothing.

**Entries at once**, on the **LoreBase books** card, is how many entries get their keys written at the same time: 6 entries by default, and 1 to 8 entries. More is faster, but it can run into your provider's rate limits.

**Nothing rewrites keys on its own.** Edit an entry in World Info, and VectFox writes the vectors of the parts you changed again, by itself. Its keys stay as they are. When you want new ones, that's the pencil on its row, or **Regenerate keys**, 1 call per entry. The one exception is [Entity-Lore](entity-lore.md), which writes its own entries again as your story goes on, and their keys with them.

**Every reply.** On Fast and Cheap [Jev], a reply is 1 call, to Jev. Above 100 ready entries, the search adds 1 request to your embedding model, which isn't an LLM call.

On High Accuracy, a reply is 1 pick, plus 1 review for each entry it picked. An entry of only 1 part, or one with template code, skips its review. So at the default Pick limit of 6 entries, a reply is at most 1 + 6 = 7 calls. The reviews all go out at the same time, so the reply waits for the slowest one, not for all 6 in a row.

And every reply means EVERY one. Swipe 5 times, and that's 5 picks. In a group chat, each member who answers gets a pick of their own. **Try a pick**, on the **LoreBase tester** tab, costs the same as one reply's pick, and sends no reply.

Say you turn on 200 entries in Harbor Atlas and play 100 replies. Getting them ready is 200 calls, once. On Fast and Cheap, the 100 replies are 100 calls to Jev. On High Accuracy, they're 100 picks plus their reviews, so at most 100 × 7 = 700 calls at the default Pick limit.

| What | LLM calls | How often |
|---|---|---|
| Keys of an entry you turn on | 1 | Once |
| Its vectors | None, that's the embedding model | Once, and again for each part you edit |
| A reply on Fast and Cheap [Jev] | 1, to Jev | Every reply |
| A reply on High Accuracy | 1 pick, and up to 6 reviews | Every reply |
| Regenerate in the pencil, or Regenerate keys | 1 per entry | When you press it |
| Import of a keys or vectors file | None | When you press it |

**What costs nothing.** An entry you don't turn on. Every reply while **Use LoreBase** is off, or in a chat with no book locked to it. And Import, which puts saved keys and vectors back with no call at all.

## Before you turn it on

A few things have to be set first:

- VectFox runs on Qdrant, the vector backend you pick on the **Core** page. LoreBase keeps every entry's keys and vectors there.
- VectFox's embedding model works (**Core** > **Embedding**, the same one your chat memory uses).
- The **LoreBase model** card has a model. It writes the keys, whichever way LoreBase picks. I tested LoreBase on GPT-6 Luna.
- On Fast and Cheap [Jev], the card's **Jev** group has a profile for Jev too.
- SillyTavern's Vector Storage has **Enabled for World Info** off. That one sends whole entries on its own, whatever LoreBase picks, and LoreBase can't take them back. VectFox asks about it when you turn LoreBase on.

If something is missing, the notice at the top of the model card names it.

Then press **Choose entries**, turn on the entries you want LoreBase to decide, and close the screen. Turn on **Use LoreBase**, and VectFox asks to write their keys and vectors, with a progress panel that counts them.

With **Use LoreBase** off, every entry fires by its keys again, like SillyTavern does. Your selections, pins and locks are all kept, so turning it back on picks up where you left off.

## How I choose entries

I go through a book in the same order every time. Even a book of 300+ entries is quick, because you mostly click categories, not entries.

**1. Start with the categories.** The author already sorted the book for you. Ask each category one question: does a reply need this only when the story is about it? Characters, places, monsters, items, magic, history, that's lore. Turn the whole category on with its wand.

**2. Leave the rules to SillyTavern.** World rules, writing style, the card's setting... every reply must follow those, whatever the scene is about. Most of them are constant anyway, so the screen won't even let you turn them on. Engine entries stay SillyTavern's too, which is why the category wands skip them.

**3. Go through No category by hand.** Authors park their odd entries there: credits, dividers, rules, and lore they never sorted. Turn on the lore, and leave the credits and dividers off. Every entry you turn on is one more line the pick reads, or one more question Jev answers, on every single reply. An empty one says **Empty**, and can't even be turned on.

**4. Leave the big overviews to SillyTavern.** Some books have an overview for each topic, like one entry that explains how all the magic works. The LoreBase model picks the specific entries instead, so it almost never picks an overview. In my test, the magic overview wasn't picked once in 12 replies, even when the whole scene was a lesson about magic, and even after I gave it a clear title. If your story needs those overviews, leave them to SillyTavern.

**5. Leave the main character to SillyTavern.** I mean the one every reply is about, usually the one you play. Their sheet is needed in most replies, so it works like a rule. In my test the main character's sheet was needed in 7 of 12 replies, and LoreBase picked it in only 2 of those.

**6. Turn on the small ones too.** Monster and item entries are often 100 tokens or so, but their keys are common words like "King" or "dog". With keys, they ride along on lots of replies just because someone said the word. Turned on, they go in only when the scene is about them. On High Accuracy, each one adds its title and keys to every pick, about 30 tokens on my test book, and the line at the bottom of the screen adds them up for you.

**7. Try it on one chat first.** Writing the keys locks the book to the chat you're in, and only that one. Play 10 replies or so there, and open the **LoreBase tester** tab. It shows what was picked and why, which parts went in, and the tokens next to what SillyTavern's keys would have sent. Happy with it? Lock the book to the character too.

## What to expect

LoreBase is picky. On my test book, with 311 of its 320 entries turned on, SillyTavern's keys would have sent 12,000 to 35,000 tokens of those entries on every reply, and only about a quarter of it was useful. LoreBase sent 700 to 2,300 tokens, and almost all of it was useful.

But picky cuts both ways. LoreBase sends what it is sure the next reply needs, and sometimes it leaves out something that would have helped, most often when a scene has many people or many topics at once. So if a reply forgets something, open the tester and look. If LoreBase left that entry out, you can leave it to SillyTavern.

If you play in another language than your book, like Chinese against an English book, turn on more. Keys miss across languages. The LoreBase model doesn't.

The rest of this page goes through the Choose entries screen and the **LoreBase books** card, button by button, for when you need it.

## The Choose entries screen

**Choose entries**, on the **LoreBase books** card, opens the screen on the first book of your chat, and the list button on a book's row opens that book. Both open on the selection your chat uses, or on the book's first if it uses none. Selections are explained in **More than one selection of a book**, below.

### Ticked is NOT on

This is the part that confuses everyone, so I'll say it first. Each entry row has 2 controls, and they do different things.

- The **wand button** on the right of the row turns LoreBase on or off for that entry. Pressed means on. It saves right away.
- The **checkbox** on the left only ticks the row. A tick does nothing on its own. It's a mark for the buttons above the list, so you can change many entries at once.

It works like the checkboxes in your email inbox. Ticking 20 emails doesn't delete anything. Pressing Delete does.

2 pills tell them apart. The **selected** pill at the top right counts the entries that are on in the selection you see. The **ticked** pill above the list counts your ticks.

Ticks are never saved. They go away when you switch to another book or close the screen. Everything else saves as you click it: the wands, Turn on and Turn off, the locks and the pins.

### Categories

LoreBase reads a category from the start of an entry's title in World Info. "[Places] Lighthouse of Vell" is in the category [Places], with the title "Lighthouse of Vell". A title starting with 【…】, or with a short word and a colon like "People:", works too. Entries with none are under **No category**, at the bottom.

Each category row says how many entries it has and how many are on, with a pill: **Off** when none is on, **Some on**, or **All on**.

- The **filter button** shows only that category's entries in the list. **All categories**, at the top, shows them all again.
- The **wand button** turns LoreBase on for every entry in the category. On an All on category it does the opposite, and turns the whole category off, any engine entry you turned on by hand included.

The category's wand skips engine entries (see the pills below), and entries SillyTavern keeps. You turn engine entries on one by one. So a category of nothing but those has its wand greyed out.

Nothing is saved per category. An entry you add to [Places] later shows up off, with a New pill, so you decide on it yourself.

### Pinned sections

Big entries get cut into parts by their headings, like a character entry with Appearance, History and Speech Style. Those headings are the sections. On High Accuracy, LoreBase sends only the parts the reply needs, so sometimes Speech Style is left out.

If a section should ALWAYS go in when its entry is picked, tick it under **Pinned sections**. Pin Speech Style, and every picked entry with a Speech Style section brings it along, even when the review left it out. The one exception is an entry the review says the reply uses none of. That one sends nothing at all.

Fast and Cheap [Jev] sends every picked entry whole, so pins only matter on High Accuracy.

The list shows the section names in the entries you turned on, the most common first, each with how many entries hold it. It stays empty until you turn on an entry with sections. Pins are per selection.

### Finding entries

The dropdown at the top lists every lorebook in SillyTavern. The books your open chat loads come first, marked "(this chat)", then the rest by name. A book with entries on says how many of them LoreBase decides, the same number its row on the card shows, like "Harbor Atlas (this chat), 12 selected".

The row under the locks narrows the list. Filters only change what you see. They never turn anything on or off, and they stay as you set them until you close the screen.

| Filter | What it shows |
|---|---|
| Search | Entries with every word you type somewhere in their title, keys or text. Case doesn't matter. |
| Any size | Only entries of at least 300, 1,000 or 3,000 tokens. |
| Ready or not | Only the entries you turned on that are ready, or only those still without keys or vectors. Handy after a run where some failed. |
| Any badge | Only entries with one badge. The badges are explained below. |
| All entries | Pick "New since last opened" to see only the entries added to the book since you last opened it here. |

### The entries list

Each row shows the entry's title, its category, its size in tokens, how many keys it has in SillyTavern, and its pills. Its buttons: the **eye** shows the whole entry, with what each of its pills means. The **pencil** opens its LoreBase keys, on an entry you turned on. And the **wand** turns it on or off.

An entry you turned on also shows where its keys and vectors stand: **Writing keys** or **Vectorizing** while a run writes them, **No keys or vectors yet**, **No keys yet** or **No vectors yet** before that, and **Vectors from another model** after you switch your embedding model. If its writing failed, it says **Keys failed** or **Vectors failed**, with the reason under the title. A ready entry shows the keys the LoreBase model wrote for it instead, or **No keys found** when the model found nothing in it to key.

The pencil's dialog holds the entry's LoreBase keys, one per line, and you can type your own. **Regenerate** asks the LoreBase model for new ones, 1 call, and puts them in the box so you can read them first. Nothing is kept until you press **Save keys**.

The buttons above the list work on your ticks:

- **Tick all matching** ticks every entry your filters show, even the ones further down that the list hasn't drawn yet. It skips engine entries and the ones SillyTavern keeps.
- **Untick all** clears every tick.
- **Invert** flips the tick of every entry your filters show. It never ticks an engine entry, or one SillyTavern keeps.
- **Turn on** and **Turn off** turn LoreBase on or off for every ticked entry.
- **Regenerate keys** writes new keys for every ticked entry you turned on, 1 call each, under the progress panel. Keys you typed by hand get replaced too.

Hold Shift and click a checkbox, and every row between it and the last one you clicked gets the same tick.

One thing to watch. A tick stays when a filter hides its row. If you tick 10 entries in [Places], then show [People] and press Turn on, the 10 in [Places] are turned on too. The ticked pill always counts them all. When in doubt, press Untick all first.

The list draws 100 entries at a time. **Show more** draws the next 100.

At the bottom, a line says what your entries cost each reply, counting the ready ones, the only ones a reply sends. On High Accuracy, it's how many titles the LoreBase model reads from this book, each with its keys, and about how many tokens that adds to every pick. On Fast and Cheap [Jev], it's how many ready entries Jev is asked about: every one while the books locked to this chat have 100 or fewer ready, and above that the 100 a search finds best. If the selection you see isn't the one this chat uses, the line says it takes no part here. After it, the screen counts where the keys and vectors stand, like `Keys and vectors: 300 ready, 13 not written yet.`

### The pills on a row

Some pills say why an entry can't be turned on. The rest are there to help you choose.

| Pill | What it means |
|---|---|
| Constant, Sticky, Cooldown | SillyTavern keeps this entry. A constant entry always goes in, and sticky and cooldown timers only work when SillyTavern fires the entry itself. So it can't be turned on, and it can't be ticked. |
| `@@activate`, `@@dont_activate` | SillyTavern keeps this entry too. That line at the top of the entry tells SillyTavern to send it on every reply, or never, and SillyTavern follows it whatever LoreBase sends. So it can't be turned on, and it can't be ticked. |
| Empty | It has no text, so LoreBase has nothing to key, pick or send. It can't be turned on, and it can't be ticked. |
| Disabled | Turned off in World Info. You can turn it on here, but LoreBase skips it until you enable it again. |
| New | Added to the book since you last opened it on this screen. The first time you open a book, nothing is new. |
| Template code | Has template code, like `<% %>` blocks. When picked, it goes in whole, never cut. |
| Mostly code | At least half of it is template code. |
| Engine | A game engine's entry, like MVU's state entries. |
| Code keys | Every key looks like a code, such as `#0765792`, not a word. |
| No keys | Fine for LoreBase. It reads the title and the keys its own model writes, not SillyTavern's. Turned on, LoreBase can even send an entry no key ever fired. |
| Long | 1,000 tokens or more. On High Accuracy, this is where LoreBase saves the most, since it leaves out the parts the reply doesn't need. On Fast and Cheap [Jev] it goes in whole, so it takes a big bite of the lore budget. |
| No title | The pick sees it only as "entry" and its UID, with its keys, so it has way less to go on. Give it a title in World Info first. |

If an entry was on before SillyTavern kept it, or before it went empty, you can still turn it off.

Engine, Code keys and Mostly code are what I call engine entries. They drive a game rather than tell lore, so Tick all matching, Invert and a category's wand skip them. You can still turn one on with its own wand, or tick it by hand.

## The lock: where LoreBase decides

Turning entries on says WHICH entries LoreBase decides. Locking says WHERE. LoreBase decides a book's entries only in a chat, or with a character, that one of its selections is locked to. Everywhere else the whole book fires by its keys, and your selection just waits.

- **Lock to this chat**: LoreBase decides this selection's entries in the chat you have open.
- **Lock to this character**: the same in every chat with this character.

You don't have to lock the chat yourself. Once LoreBase writes the keys of the entries you turned on, it locks their book to the chat you have open. That's when you close Choose entries and press **Write keys and vectors**, turn on **Use LoreBase**, or press **Generate keys** or **Generate all**. The card's status line tells you, like `Locked "Harbor Atlas" to this chat.` It only does that for a book with 1 selection. Once a book has more, which one a chat uses is your call.

A book already locked to this chat or this character stays as it is. And if you changed a lock on the screen, closing it keeps your choice, so a lock you turned off there stays off. Locking to the character is always your call.

So you can turn on 50 entries in Harbor Atlas in your Wren chat to try them. Only that chat changes, your other chats don't. If you like it, lock it to the character too.

In a group chat, a book a member loads, their own lorebook or one of their Additional Lorebooks, locks to that member. The note under the switches names who, and the lock works on that member's turns. The card lists every member's books too. A book no member loads, like one in the global list or the Chat Lorebook, can only be locked to the chat. With no chat open, neither lock can.

## More than one selection of a book

A selection is the entries you turn on in a book, with its pins and its locks. Every book starts with 1, named after the book. Make another when you want a different set of the same book in another chat. Say all of Harbor Atlas in your Wren chat, but only its harbor entries in your Orrin chat. Then you don't turn entries off and on again each time you switch chats.

All the selections of a book share its keys and vectors. So a new selection writes nothing for the entries the book already has ready.

The row under the book's dropdown is for them. Its list has the book's selections, and the one this chat uses says "(in use here)".

- Picking another one in that list only shows it, so you can change it. It doesn't put it in use.
- **New selection** copies the one you see, its entries and pins but not its locks, as "Harbor Atlas 2". The copy goes in use in this chat right away.
- **Rename** gives the one you see a new name.
- **Delete** deletes the one you see, after asking, with the vectors no other selection needs. A book's last selection can't be deleted.

A chat uses 1 selection of a book at most. Lock one to this chat, and this chat's lock comes off the book's other selections. The same goes for the character. When the chat and the character lock different ones, the chat's lock wins. So you can lock your usual selection to Keeper Orrin, and another one to the one chat that needs it.

You don't even need the screen to switch. On the card, each book's row starts with **Selection in use here**. Pick a selection there, and this chat uses it from the next reply on. Its last choice, **New selection**, makes the copy and opens the screen on it. While no selection of the book is in use here, it says **None in use here**, and the book fires by its keys in this chat.

## A book your chat doesn't load yet

LoreBase only decides books your chat loads. If the book you want isn't on the **LoreBase books** card, add it with **Add a lorebook**, under the list of books. Its list has every lorebook your chat doesn't load yet.

Pick the book, then one of the 2 buttons:

- **Add to this chat** adds it to this chat only. You can add as many books as you like this way, and LoreBase locks each one to this chat.
- **Add to this character** puts it in the character's Additional Lorebooks. It loads in every chat with this character, and LoreBase locks it to the character.

Right after you add a book, the screen opens on it, with nothing turned on. You pick its entries like any other book's. A group chat has no one character, so it only gets **Add to this chat**.

A book you add to this chat belongs to LoreBase, not to SillyTavern. So it only loads while **Use LoreBase** is on. Turn LoreBase off, and nothing from it goes into your prompt. Whatever you set up in SillyTavern itself keeps working exactly like before, LoreBase on or off.

Why not SillyTavern's Chat Lorebook? Because a chat only gets 1 of those, and a lot of you already use it. I didn't want **Add to this chat** to kick your book out of that slot, or to leave you stuck at 1 book. And it doesn't use **Active World(s) for all chats** either. That one loads a book in EVERY chat, so a book for this story would show up in all your other stories too.

To take it out again, press **Unlink**, the broken-link button on its row, which **Taking a book out** explains below. A book you added to the character can also be taken out in SillyTavern, like any other book, but then LoreBase keeps what it had for it.

If you rename or delete a book in SillyTavern after adding it to this chat, its row says **Missing from SillyTavern**, and it sends nothing. Press **Unlink** on it to clear it out, then add the book again under its new name.

## Getting entries ready

An entry you turn on takes part only once it has its keys and its vectors. Until then, it sends nothing. The entries that are ready keep working meanwhile.

So when you close Choose entries with new entries on, VectFox asks to write them, and a progress panel counts them. Say **Not now**, and LoreBase goes on with the ready ones. It only turns off when no entry is ready at all.

The Generate buttons on the **LoreBase books** card write whatever is missing later. **Generate all** writes both. **Generate keys** writes just the missing keys, and **Generate vectors** just the missing vectors. Generate vectors never calls the LoreBase model, so it costs almost nothing. It's the one to press after you switch your embedding model.

Each book's row on the card tells you where its selection in use here stands, like `313 selected, 313 with keys, 300 with vectors`. Its pill says what that means: **Ready**, or what the rest still need, like `13 need vectors`. While a run writes the book, the pill counts along, like `Vectorizing, 120 of 313`. If some entries failed, it says how many, and the line under the numbers gives the first reason. After you switch your embedding model, it says **Vectors from another embedding model**.

Under the books, one line adds up the books locked to this chat, like `2 books locked here: 312 entries ready, 40 entries waiting for keys or vectors.` So a book that still waits shows right there, while LoreBase goes on with the rest.

You don't have to keep them up to date yourself. Edit an entry in World Info, and VectFox writes the vectors of the parts you changed again. Turn an entry off, and its vectors are deleted when you close Choose entries, unless another selection of the book still has it on. Its keys stay, in case you turn it back on. Delete an entry in World Info while LoreBase is on, and its keys and vectors go with it. So the next entry you make there gets keys of its own, never the old one's.

## Saving your keys, and getting them back

Keys are the part worth saving, since each one cost a LoreBase model call. A book of 313 entries is 313 calls. Export them once, and after a reinstall, a new PC or a delete you regret, Import brings them all back with no LLM call at all. Vectors work the same way, and Import puts them back with no embedding call.

It's all in the **Database Browser**, under the type LoreBase, right after your chat collections. Each book you use with LoreBase has a row there, like a chat collection: its name, how many entries its selections turn on, and where its vectors are stored. A book with more than 1 selection says how many, like `Selected entries: 312, in 2 selections`. Under it sit 2 rows, its keys and its vectors, like `313 entries with keys` and `504 parts`.

Each of those 2 rows has its own Export, Import and Delete. Export saves that one kind to a file. Import puts a file back. Delete removes that kind, of that book, and nothing else. Your selections stay, LoreBase stays on, and those entries just sit out of your replies until Generate keys or Generate vectors writes them again.

Import only writes what still matches. A keys file goes onto an entry only when its number AND its title match, because every book numbers its entries 0, 1, 2. That's what keeps another book's keys off your entries. A vectors file goes onto a part only when that part still has the same text.

Before it writes, Import tells you how many it writes, how many of those replace what the book has, and how many it skips. Say Cancel, and nothing changes. Both kinds go onto an entry whether a selection has it on or not. But the next write erases the vectors of an entry no selection has on, so Import tells you how many of those there are.

If you switched your embedding model since the export, Import says so, and embeds those parts again with your current model, the same as Generate vectors. Only the entries your selections have on get embedded. To use the saved vectors as they are, switch back to the model the file names first.

After a fresh install, a book isn't in the list at all, since it has nothing stored and you never opened it in Choose entries. That's what **Import a collection**, at the top of the list, is for. Give it a keys or vectors file, and it puts it into the lorebook the file names, with the same check before it writes. So after a fresh install:

1. Bring the lorebook into SillyTavern, as always.
2. Import its keys file, then its vectors file, with Import a collection.
3. Select its entries. The ones you had before already have their keys and vectors, so nothing gets written for them, and no model gets called.

See a ⚠ next to a book's name? None of its selections has an entry on, so LoreBase leaves the whole book out of your replies. Its keys stay. Its vectors don't: the next write erases them, like the next time you change its selection, unless you select their entries first. Hover the ⚠ and it tells you the same. On a phone, tap it.

The vectors row also has **View chunks**, the eye button. It opens the book's chunks the way a chat collection's open, one chunk for each part of an entry: the entry's title, then that part's text. They're listed by entry and part, and you can search them.

You can't edit a chunk itself, since LoreBase writes them from your entries. To change one, open it and press **Edit entry**. That opens the entry it came from, its title and its text. **Save** writes them into the lorebook, then writes that entry's vectors again, so the chunks you see after it are the new ones. That works even while LoreBase is off. The entry's LoreBase keys stay as they are, the same as after an edit in World Info.

Some keys and vectors LoreBase can't use here at all: those of a book you deleted from SillyTavern, vectors marked "Not read" that sit in the other collection from before you switched One shared collection, and points that name no book. They wait behind **Show leftovers**, under the list, which only shows up when there are some. Each one has Export, Delete and View chunks, so you can keep a copy and clean up. There's no Import or Edit entry there, since nothing here could take them.

## Taking a book out

There are 4 ways, from small to big. Each one asks first, and says what goes before it goes.

- **Delete**, in Choose entries, deletes 1 selection: its entries, pins and locks, and the vectors no other selection needs. The book and its other selections stay. On the **LoreBase books** card, the trash on a book's row does the same, when the book has 2 or more selections and one of them is in use here.
- **Remove from LoreBase** deletes everything LoreBase keeps for the book: all its selections, with their entries, pins and locks, its keys AND its vectors. It's the trash on the book's own row in the Database Browser, and the card's trash on any other book. The book stays in SillyTavern and in your chat, so its entries just fire by their keys again.
- **Unlink**, the broken-link button right before the card's trash, deletes everything Remove from LoreBase deletes, and takes the book out of the chat too. It's on each book your chat loads through **Add to this chat**, its Chat Lorebook, the character's Additional Lorebooks or SillyTavern's global list. So it's gone from the card, and **Add a lorebook** offers it again. Careful with the global list: a book there loads in EVERY chat, so it leaves all of them. The character's own lorebook and your persona's have no Unlink, since they load in other chats too. Take those out in SillyTavern.
- **Delete all**, on the **LoreBase books** card, deletes every LoreBase key and vector in every book, and turns **Use LoreBase** off. Your selections stay, but keys you typed by hand are gone.

Leftovers don't get these buttons. You clean those up one row at a time, under **Show leftovers**.

Basically, turn on the lore, leave the rules, the overviews and the main character to SillyTavern, and let LoreBase decide what goes in. It costs 1 call per entry once, then 1 call or a few on every reply, and everything you don't turn on keeps working the old way.
