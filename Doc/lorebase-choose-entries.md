# Choosing entries for LoreBase

This screen is where you tell LoreBase which lorebook entries it decides. Every entry you don't turn on here stays SillyTavern's, and fires by its keys like it always did.

## Before you open it

You open it from VectFox's **WorldInfo** page. In the **LoreBase books** card, **Choose entries** opens the first book of your chat, and the list button on a book's row opens that book. Both open on the selection your chat uses, or on the book's first if it uses none. Selections are explained in **More than one selection of a book**, below.

A few things have to be set first:

- **Use LoreBase** is on.
- VectFox runs on Qdrant, the vector backend you pick on the **Core** page. LoreBase keeps every entry's keys and vectors there.
- VectFox's embedding model works (**Core** > **Embedding**, the same one your chat memory uses).
- The **LoreBase model** card has a model. It writes the keys, whichever way LoreBase picks.
- On Fast and Cheap [Jev], the card's Jev group has a profile for Jev too.
- SillyTavern's Vector Storage has **Enabled for World Info** off. VectFox asks about that one when you turn LoreBase on.

If Qdrant or one of the models is missing, the notice at the top of the model card names it.

## A book your chat doesn't load yet

LoreBase only decides books your chat loads. If the book you want isn't in the **LoreBase books** card, add it with **Add a lorebook**, under the list of books. Its list has every lorebook your chat doesn't load yet.

Pick the book, then one of the 2 buttons:

- **Add to this chat** adds it to this chat only. You can add as many books as you like this way, and LoreBase locks each one to this chat.
- **Add to this character** puts it in the character's Additional Lorebooks. It loads in every chat with this character, and LoreBase locks it to the character.

A book you add to this chat belongs to LoreBase, not to SillyTavern. So it only loads while **Use LoreBase** is on. Turn LoreBase off, and nothing from it goes into your prompt. Whatever you set up in SillyTavern itself keeps working exactly like before, LoreBase on or off.

Why not SillyTavern's Chat Lorebook? Because a chat only gets 1 of those, and a lot of you already use it. I didn't want **Add to this chat** to kick your book out of that slot, or to leave you stuck at 1 book. And it doesn't use **Active World(s) for all chats** either. That one loads a book in EVERY chat, so a book for this story would show up in all your other stories too.

To take a book out again, press **Unlink**, the broken-link button on the book's row. After asking, it takes the book back out of where it went AND deletes what LoreBase keeps for it. A book you added to the character can also be taken out in SillyTavern, like any other book, but then LoreBase keeps what it had for the book.

If you rename or delete a book in SillyTavern after adding it to this chat, its row says **Missing from SillyTavern**, and it sends nothing. Press **Unlink** on it to clear it out, then add the book again under its new name.

Right after you add a book, this screen opens on it, with nothing turned on. You pick its entries like any other book's.

A group chat has no one character, so it only gets **Add to this chat**.

## What turning an entry on does

An entry you turn on goes in only when LoreBase picks it for the next reply. On High Accuracy, only with the parts of it the reply needs.

Say your book Harbor Atlas has an entry Lighthouse of Vell, 1,500 tokens, with the key "lighthouse". With SillyTavern's keys, every time someone says "lighthouse", all 1,500 tokens go in. Even when Wren only says "I can see the lighthouse from here".

Turn it on, and its keys stop firing it. Before each reply, LoreBase reads the last few messages and picks the entries the reply needs. So when Keeper Orrin is about to tell the lighthouse's history, Lighthouse of Vell goes in, and on High Accuracy only its history part. When nobody needs it, nothing goes in. The exact steps are in **How LoreBase works**, at the end.

It's like asking a librarian instead of a search box. The search box gives you every book with "lighthouse" on its cover, whole. The librarian asks what you are working on, and hands you the 2 books you need.

On one of my test chats, the keys fired 8 of the entries I gave LoreBase, 5,729 tokens. LoreBase sent 2 of them, cut down to 1,162 tokens.

In the prompt, everything LoreBase sends sits inside a `<VectLorebook>` block, each entry in a tag named after it, like `<Lighthouse_of_Vell>`. So you can tell it apart from SillyTavern's own entries, and so can the AI.

## Keys and vectors

An entry you turn on takes part only once it has 2 things. Its keys, which the LoreBase model writes, one call per entry. And its vectors, which VectFox's embedding model writes from the entry's title and text.

So when you close this screen with new entries on, VectFox asks to write them, and a progress panel counts them. Until an entry has both, it sends nothing. The entries that are ready keep working meanwhile.

Say "Not now", and LoreBase goes on with the ready ones. It only turns off when no entry is ready at all. **Generate all** on the WorldInfo page writes whatever is missing later.

Each book's row on the WorldInfo page tells you where its selection in use here stands, like `313 selected, 313 with keys, 300 with vectors`, and its pill says what that means: **Ready**, or what the rest still need, like `13 need vectors`. While a run writes the book, the pill counts along, like `Vectorizing, 120 of 313`. If some entries failed, it says how many, and the line under the numbers gives the first reason. After you switch your embedding model, it says **Vectors from another embedding model**. A book with no selection in use here counts every entry its selections turn on.

Under the books, one line adds up the books locked to this chat, like `2 books locked here: 312 entries ready, 40 entries waiting for keys or vectors.` So a book that still waits shows right there, while LoreBase goes on with the rest.

Need only one of the 2? **Generate keys** writes just the missing keys, and **Generate vectors** just the missing vectors. Generate vectors never calls the LoreBase model, so it costs almost nothing. It's the one to press after you switch your embedding model.

You don't have to keep them up to date. Edit an entry in World Info, and VectFox writes the vectors of the parts you changed again by itself. Turn an entry off, and its vectors are deleted when you close this screen, unless another selection of the book still has it on. Its keys stay, in case you turn it back on.

## Saving them, putting them back, deleting one book

The Database Browser lists every lorebook you use with LoreBase, under the type LoreBase, right after your chat collections. Each one looks like a chat collection: a row with the book's name, how many entries its selections turn on, and where its vectors are stored. A book with more than 1 selection says how many, like `Selected entries: 312, in 2 selections`. Under it sit 2 rows, its keys and its vectors, like `313 entries with keys` and `504 parts`. So you see what a book holds without opening anything.

See a ⚠ next to a book's name? None of its selections has an entry on, so LoreBase leaves the whole book out of your replies. Its keys stay. Its vectors don't: the next write erases them, like the next time you change its selection, unless you select their entries first. Hover the ⚠ and it tells you the same. On a phone, tap it.

Each row has its own Export, Import and Delete. Export saves that one kind to a file. Import puts a file back. Delete removes that kind, of that book, and nothing else. Your selections stay, LoreBase stays on, and those entries just sit out of your replies until Generate keys or Generate vectors writes them again.

Want the whole book gone from LoreBase, not just one kind? Press the trash button on the book's own row, **Remove from LoreBase**. It deletes everything LoreBase keeps for that book: all its selections, with their entries, pinned sections and locks, its keys AND its vectors. It asks first, in red, and names each part, so you see what goes before it goes. Only want 1 of its selections gone? That's **Delete** in **Choose entries**, and the question says so in green when the book has more than 1. The trash on the book's WorldInfo row does it too, for the selection in use there.

The book itself stays in SillyTavern. So its entries just fire by their keys again, like any book LoreBase doesn't use. Leftovers don't get the button: you clean those up one row at a time.

The **LoreBase books** card on the WorldInfo page has a trash button too, on each book LoreBase keeps something for. When the book has 2 or more selections and one of them is in use here, the one its dropdown shows, the trash deletes just that selection, like **Delete** in **Choose entries**: its entries, pins and locks, and the vectors no other selection needs. The book and its other selections stay. Otherwise the trash is **Remove from LoreBase**, the same as above, and the book stays in your chat, with nothing selected and no lock.

Want the book out of the chat too? That's **Unlink**, the broken-link button right before the trash. It's on each book your chat loads through its Chat Lorebook, the character's Additional Lorebooks or SillyTavern's global list. It deletes everything **Remove from LoreBase** deletes, AND unlinks the book from those places. So it's gone from the card, and **Add a lorebook** offers it again. It asks first, in red, and tells you unlinking deletes its keys and vectors too. Careful with the global list: a book there loads in EVERY chat, so it leaves all of them. The character's own lorebook and your persona's have no Unlink, since they load in other chats too. Take those out in SillyTavern.

The vectors row also has **View chunks**, the eye button. It opens the book's chunks the way a chat collection's open, one chunk for each part of an entry: the entry's title, then that part's text. They're listed by entry and part, and you can search them.

You can't edit a chunk itself, since LoreBase writes them from your entries. To change one, open it and press **Edit entry**. That opens the entry it came from, its title and its text. **Save** writes them into the lorebook, then writes that entry's vectors again, so the chunks you see after it are the new ones. That works even while LoreBase is off. The entry's LoreBase keys stay as they are: the pencil on the selection screen writes new ones. Editing the entry in SillyTavern's World Info works too, and while LoreBase is on, it writes that entry's chunks again by itself.

Leftovers have View chunks too, but no Edit entry: their book isn't in SillyTavern, or their vectors aren't where LoreBase writes them now.

This matters MOST for keys. They cost a LoreBase model call for every entry, so a book of 313 entries is 313 calls. Export them once, and after a reinstall, a new PC or a Delete you regret, Import brings them all back with no LLM call at all. Vectors work the same way, and Import puts them back with no embedding call.

Import only writes what still matches. A keys file goes onto an entry only when its number AND its title match, because every book numbers its entries 0, 1, 2. That's what keeps another book's keys off your entries. A vectors file goes onto a part only when that part still has the same text. Both go onto an entry whether a selection has it on or not. Vectors of an entry no selection has on get erased on the next write, though, so Import tells you how many of those there are.

Before it writes, Import tells you how many it writes, how many of those replace what the book has, and how many it skips. Say Cancel, and nothing changes.

If you switched your embedding model since the export, Import says so, and embeds those parts again with your current model, the same as Generate vectors. Only the entries your selections have on get embedded. To use the saved vectors as they are, switch back to the model the file names first.

A book isn't in the list at all when it has nothing stored and you never opened its selection screen, like after a fresh install. Use **Import a collection**, at the top of the list. Give it a keys or vectors file, and it puts it into the lorebook the file names, with the same check before it writes. The book shows up in the list right after, with its ⚠ until you select entries. So after a fresh install:

1. Bring the lorebook into SillyTavern, as always.
2. Import its keys file, then its vectors file, with Import a collection.
3. Select its entries. The ones you had before already have their keys and vectors, so nothing gets written for them, and no model gets called.

Some keys and vectors LoreBase can't use here at all: those of a book you deleted from SillyTavern, vectors marked "Not read" that sit in the other collection from before you switched One shared collection, and points that name no book. They wait behind **Show leftovers**, under the list, which only shows up when there are some. Each has Export and Delete, so you can keep a copy and clean up. There's no Import there, since nothing here could take it.

## Ticked is NOT on

This is the part that confuses everyone, so I'll say it first. Each entry row has 2 controls, and they do different things.

- The **wand button** on the right of the row turns LoreBase on or off for that entry. Pressed means on. It saves right away.
- The **checkbox** on the left only ticks the row. A tick does nothing on its own. It's a mark for the **Turn on** and **Turn off** buttons above the list, so you can change many entries at once.

It works like the checkboxes in your email inbox. Ticking 20 emails doesn't delete anything. Pressing Delete does.

2 pills tell them apart. The **selected** pill at the top right counts the entries that are on in the selection you see. The **ticked** pill above the list counts your ticks.

Ticks are never saved. They go away when you switch to another book or close the screen. Everything else saves as you click it: the wands, Turn on and Turn off, the locks and the pins.

## The lock: where LoreBase decides

Turning entries on says WHICH entries LoreBase decides. Locking says WHERE. LoreBase decides a book's entries only in a chat, or with a character, one of its selections is locked to. Everywhere else the whole book fires by its keys, and your selection just waits.

- **Lock to this chat**: LoreBase decides this selection's entries in the chat you have open.
- **Lock to this character**: the same in every chat with this character.

You don't have to lock the chat yourself. Once LoreBase writes the keys of the entries you turned on, it locks their book to the chat you have open. That's when you close this screen and press **Write keys and vectors**, turn on **Use LoreBase**, or press **Generate all**. The line under Generate all tells you, like `Locked "Harbor Atlas" to this chat.` It only does that for a book with 1 selection. Once a book has more, which one a chat uses is your call.

A book already locked to this chat or this character stays as it is. And if you changed a lock on this screen, closing it keeps your choice, so a lock you turned off there stays off. Locking to the character is always your call.

So you can turn on 50 entries in Harbor Atlas in your Wren chat to try them. Only that chat changes, your other chats don't. If you like it, lock it to the character too.

In a group chat, a book a member loads, their own lorebook or one of their Additional Lorebooks, locks to that member. The note under the switches names who, and the lock works on that member's turns. The WorldInfo page lists every member's books too. A book no member loads, like one in the global list or the Chat Lorebook, can only be locked to the chat. With no chat open, neither lock can.

## More than one selection of a book

A selection is the entries you turn on in a book, with its pins and its locks. Every book starts with 1, named after the book. Make another when you want a different set of the same book in another chat. Say all of Harbor Atlas in your Wren chat, but only its harbor entries in your Orrin chat. Then you don't turn entries off and on again each time you switch chats.

All the selections of a book share its keys and vectors. So a new selection writes nothing for the entries the book already has ready.

The row under the book's dropdown is for them. Its list has the book's selections, and the one this chat uses says "(in use here)".

- Picking another one in that list only shows it, so you can change it. It doesn't put it in use.
- **New selection** copies the one you see, its entries and pins but not its locks, as "Harbor Atlas 2". The copy goes in use in this chat right away.
- **Rename** gives the one you see a new name.
- **Delete** deletes the one you see, after asking, with the vectors no other selection needs. A book's last selection can't be deleted. **Remove from LoreBase** removes the whole book instead.

A chat uses 1 selection of a book at most. Lock one to this chat, and this chat's lock comes off the book's other selections. The same goes for the character. When the chat and the character lock different ones, the chat's lock wins. So you can lock your usual selection to Keeper Orrin, and another one to the one chat that needs it.

You don't even need this screen to switch. On the WorldInfo page, each book's row starts with **Selection in use here**. Pick a selection there, and this chat uses it from the next reply on. Its last choice, **New selection**, makes the copy and opens this screen on it. A book with no selection yet, like right after its trash, gets its first one instead, named after the book. While no selection of the book is in use here, it says **None in use here**, and the book fires by its keys in this chat. While a book has 2 or more, the trash on its row deletes the one in use here, the same as **Delete**.

## Finding entries: the book and the filters

The dropdown at the top lists every lorebook in SillyTavern. The books your open chat loads come first, marked "(this chat)", then the rest by name. A book with entries on says how many of them LoreBase decides, the same number its WorldInfo row shows, like "Harbor Atlas (this chat), 12 selected".

The row under the locks narrows the list. Filters only change what you see. They never turn anything on or off, and they stay as you set them until you close the screen.

| Filter | What it shows |
|---|---|
| Search | Entries with every word you type somewhere in their title, keys or text. Case doesn't matter. |
| Any size | Only entries of at least 300, 1,000 or 3,000 tokens. |
| Ready or not | Only the entries you turned on that are ready, or only those still without keys or vectors. Handy after a run where some failed. |
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

Big entries get cut into parts by their headings, like a character entry with Appearance, History and Speech Style. Those headings are the sections. On High Accuracy, LoreBase sends only the parts the reply needs, so sometimes Speech Style is left out.

If a section should ALWAYS go in when its entry is picked, tick it under **Pinned sections**. Pin Speech Style, and every picked entry with a Speech Style section brings it along, even when the review left it out. The one exception is an entry the review says the reply uses none of. That one sends nothing at all.

Fast and Cheap [Jev] sends every picked entry whole, so pins only matter on High Accuracy.

The list shows the section names in the entries you turned on, the most common first, each with how many entries hold it. It stays empty until you turn on an entry with sections. Pins are per selection.

## The entries list

Each row shows the entry's title, its category, its size in tokens, how many keys it has, and its pills.

An entry you turned on also shows where its keys and vectors stand: **Writing keys** or **Vectorizing** while a run writes them, **No keys or vectors yet**, **No keys yet** or **No vectors yet** before that, and **Vectors from another model** after you switch your embedding model. If its writing failed, it says **Keys failed** or **Vectors failed**, with the reason under the title. A ready entry shows the keys the LoreBase model wrote for it instead, or **No keys found** when the model found nothing in it to key.

The buttons above the list work on your ticks:

- **Tick all matching** ticks every entry your filters show, even the ones further down that the list hasn't drawn yet. It skips engine entries and the ones SillyTavern keeps.
- **Untick all** clears every tick.
- **Invert** flips the tick of every entry your filters show. It never ticks an engine entry, or one SillyTavern keeps.
- **Turn on** and **Turn off** turn LoreBase on or off for every ticked entry.

Hold Shift and click a checkbox, and every row between it and the last one you clicked gets the same tick.

One thing to watch. A tick stays when a filter hides its row. If you tick 10 entries in [Places], then show [People] and press Turn on, the 10 in [Places] are turned on too. The ticked pill always counts them all. When in doubt, press Untick all first.

The list draws 100 entries at a time. **Show more** draws the next 100.

At the bottom, a line says what your entries cost each reply, counting the ready ones, the only ones a reply sends. On High Accuracy, it's how many titles the LoreBase model reads from this book, each with its keys, and about how many tokens that adds to every pick. Every entry you turn on is one more line it reads before every single reply, once it's ready. On Fast and Cheap [Jev], it's how many ready entries Jev is asked about: every one while the books locked to this chat have 100 or fewer ready, and above that the 100 a search finds best. If the selection you see isn't the one this chat uses, the line says it takes no part here.

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
| No keys | Fine for LoreBase. It reads the title and the keys its own model writes, not SillyTavern's. Turned on, LoreBase can even send an entry no key ever fired. |
| Long | 1,000 tokens or more. On High Accuracy, this is where LoreBase saves the most, since it leaves out the parts the reply doesn't need. On Fast and Cheap [Jev] it goes in whole, so it takes a big bite of the lore budget. |
| No title | The pick sees it only as "entry" and its UID, with its keys, so it has way less to go on. Give it a title in World Info first. |

Engine, Code keys and Mostly code are what I call engine entries. They drive a game rather than tell lore, so Tick all matching, Invert and a category's wand skip them. You can still turn one on with its own wand, or tick it by hand.

## How I choose entries

I go through a book in the same order every time. Even a book of 300+ entries is quick, because you mostly click categories, not entries.

**1. Start with the categories.** The author already sorted the book for you. Ask each category one question: does a reply need this only when the story is about it? Characters, places, monsters, items, magic, history, that's lore. Turn the whole category on with its wand.

**2. Leave the rules to SillyTavern.** World rules, writing style, the card's setting... every reply must follow those, whatever the scene is about. Most of them are constant anyway, so the screen won't even let you turn them on. Engine entries stay SillyTavern's too, which is why the category wands skip them.

**3. Go through No category by hand.** Authors park their odd entries there: credits, dividers, rules, and lore they never sorted. Turn on the lore. Leave the dividers off, and anything with 0 tokens. An empty entry has nothing to send, but the LoreBase model still reads its title, and it may pick it and waste a call on it.

**4. Leave the big overviews to SillyTavern.** Some books have an overview for each topic, like one entry that explains how all the magic works. The LoreBase model picks the specific entries instead, so it almost never picks an overview. In my test, the magic overview wasn't picked once in 12 replies, even when the whole scene was a lesson about magic, and even after I gave it a clear title. If your story needs those overviews, leave them to SillyTavern.

**5. Leave the main character to SillyTavern.** I mean the one every reply is about, usually the one you play. Their sheet is needed in most replies, so it works like a rule. In my test the main character's sheet was needed in 7 of 12 replies, and LoreBase picked it in only 2 of those.

**6. Turn on the small ones too.** Monster and item entries are often 100 tokens or so, but their keys are common words like "King" or "dog". With keys, they ride along on lots of replies just because someone said the word. Turned on, they go in only when the scene is about them. On High Accuracy, each one adds its title and keys to every pick, about 30 tokens on my test book, and the line at the bottom of the screen adds them up for you.

**7. Try it on one chat first.** Writing the keys locks the book to the chat you're in, and only that one. Play 10 replies or so there, and open the **LoreBase tester** card on the WorldInfo page. It shows what was picked and why, which parts went in, and the tokens next to what SillyTavern's keys would have sent. Happy with it? Lock the book to the character too.

## What to expect

LoreBase is picky. On my test book, with 311 of its 320 entries turned on, SillyTavern's keys would have sent 12,000 to 35,000 tokens of those entries on every reply, and only about a quarter of it was useful. LoreBase sent 700 to 2,300 tokens, and almost all of it was useful.

But picky cuts both ways. LoreBase sends what it is sure the next reply needs, and sometimes it leaves out something that would have helped, most often when a scene has many people or many topics at once. So if a reply forgets something, open the tester card and look. If LoreBase left that entry out, you can leave it to SillyTavern.

If you play in another language than your book, like Chinese against an English book, turn on more. Keys miss across languages, the LoreBase model doesn't.

Basically, turn on the lore, leave the rules, the overviews and the main character to SillyTavern, and let LoreBase decide what goes in. Everything you don't turn on keeps working the old way.

## How LoreBase works

LoreBase picks the lore for a reply in one of 2 ways, and you choose which on the **LoreBase model** card: **Fast and Cheap [Jev]**, the default, or **High Accuracy**. Both start the same way and end the same way. Only the middle is different.

Think of the librarian from before, working 2 different ways. On High Accuracy, the librarian goes down the list of titles, takes the books you need off the shelf, and reads them, so you only get the chapters you need. On Fast and Cheap, an assistant goes down the same list asking "does this one help?", and hands you the likely books whole, the best first, until your bag is full.

### What both do first

This runs before every send, swipe, regenerate and continue. Never on impersonate.

1. **It reads the scene.** That's the last 6 messages, up to and including yours. Hidden messages are skipped, and each one goes through your **Text Cleaning** first, with the AI's thinking and any game-system blocks taken out.
2. **It gathers the ready entries.** Those are the entries turned on in each book's selection in use here, the one locked to this chat or its character, that have their keys and vectors. The rest sit out, and a toast tells you how many, once per chat and again when that number changes.

### Fast and Cheap [Jev]

Jev is a small model that only answers yes or no questions, with how sure it is. It runs on the profile you pick for it in the model card's Jev group: an OpenRouter one with `typesafe/jev-1.14`, or a Custom one on Typesafe's own URL with `jev-1.14.0`.

1. **The search, only above 100 entries.** When the books locked here have more than 100 ready entries in all, a search narrows them down to 100 first. It searches with 2 texts: your last message, and the message before it, usually the AI's last reply. A message too long for your embedding model keeps only its end. Both go to your embedding model in 1 request, and each one is searched against the vectors of every book locked here at once. An entry scores by its best part, and the 100 best entries stay. With 100 entries or fewer, there's no search, and Jev gets all of them.
2. **Jev's questions.** Jev reads the scene, and one question per entry, made from its title and its keys:
   ```
   Does the next reply need the lorebook entry "Lighthouse of Vell" (about: lighthouse, Vell, keeper)?
   ```
   It answers every question with its chance of yes, from 0 to 1, all in 1 call.
3. **The cut.** Every entry Jev rates above 0.25 is a candidate. The rest are out.
4. **The lore budget.** The candidates go in WHOLE, the best first, with no review, until the lore budget is full. That's 4,000 tokens by default, and **Lore budget** on the model card takes 1,000 to 12,000 tokens. The best one always goes in, even when it's bigger than the budget. After that, an entry that doesn't fit is skipped, and the next one gets its turn.

Say Jev rated these 4 above 0.25, with the budget at 3,000 tokens:

| Entry | Jev's rating | Size | What happens |
|---|---|---|---|
| Lighthouse of Vell | 0.9 | 1,200 tokens | Goes in, 1,200 tokens so far |
| Keeper Orrin | 0.7 | 900 tokens | Goes in, 2,100 tokens so far |
| Harbor Tides | 0.4 | 1,500 tokens | Skipped, it would make 3,600 tokens |
| Vell Market | 0.3 | 400 tokens | Goes in, 2,500 tokens in all |

So a reply on Fast and Cheap is 1 call to Jev, plus the search when the books have more than 100 ready entries.

### High Accuracy

On High Accuracy, the LoreBase model does 2 jobs. It picks the entries, and then it reads them.

1. **The pick.** The LoreBase model reads a list of every ready entry, one line each, with its number, its title and the keys it wrote for it:
   ```
   12. Lighthouse of Vell (lighthouse, Vell, keeper)
   ```
   Next to the scene, it picks the entries the next reply needs, most needed first, or none. It picks at most the **Pick limit** on the model card, which shows on High Accuracy only: 6 entries by default, and it takes 1 to 12. For each one it says why, and what in it the reply needs.
2. **The cache.** The list sits at the very end of the pick's system prompt, and it's the exact same text every reply, until your selection, a title or the keys change. So after the first reply, a provider that caches reads it from its cache, which costs way less. The Pick limit isn't in that part, so changing it keeps the cache. The **LoreBase tester** shows how much it saves, like `Pick read from the cache: 10,141 of the pick's 15,070 prompt tokens`.
3. **The reviews.** Then the LoreBase model reads each picked entry, 1 call per entry, all at the same time. It gets the entry cut into numbered parts: by the author's own headings first, and into pieces of about 300 tokens where a section is still too long. It says how much of the entry the reply will use, "most", "some" or "none", and which parts are of no use right now. An entry of only 1 part, or one with template code, skips its review and goes in whole.
4. **What it sends.** Every part the review didn't leave out, in the entry's own order, plus every part of a pinned section. An entry the review says the reply uses none of sends nothing.

So a reply on High Accuracy is 1 pick and at most 1 review per pick, so up to 6 reviews at the default Pick limit, all at low reasoning effort. A higher limit can send more lore, but each extra pick of more than 1 part costs 1 more review call.

High Accuracy never searches, so it never uses the vectors. Every entry still needs them, though, so you can switch between the 2 any time and no entry drops out.

### What both do last

The picks go into the prompt inside a `<VectLorebook>` block, the most needed first. The block goes where those entries would go by their World Info position, and picks set to different positions get a block each.

When something fails, the reply goes on without that lore, and a toast tells you what happened. A failed search, Jev call or pick leaves out every entry you turned on, for that reply. A failed review leaves out only its own entry. Jev and the LoreBase model get 30 seconds to answer each call, and regenerating the message tries again.

### Which one to choose

On my test book of 313 entries, Fast and Cheap cost about $0.0004 a reply, and the whole step took about 1.8 seconds. The search was 1.3 seconds of that. High Accuracy, at its default Pick limit of 6, cost about $0.0018 a reply once the cache kicked in, and the reply waited about 7 seconds for its pick and reviews.

But High Accuracy sends way less, since it cuts entries down to what the reply needs. On that book it sent about 1,400 lore tokens a reply, where Fast and Cheap sent about 3,000 lore tokens. Your chat model reads every one of those tokens. So with a chat model of $1 per million input tokens or more, High Accuracy came out the cheaper one in all.

Basically, Fast and Cheap is the quick one, and it costs about the same on a small book or a huge one. High Accuracy is slower, but it cuts long entries down, so your prompt stays lean.
