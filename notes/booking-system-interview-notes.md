

## Intro

> "I built a seat booking backend using Node.js, Express and MySQL. The main problem it solves is double booking: if two users click Book on the last seat at the same moment, only one gets it. I used database transactions and row locking for that, with a unique database rule as a second safety layer. It also has JWT login, a 5 minute seat hold that releases by itself, cancellation with history, and automated tests that fire 20 requests at one seat."

---

## 1 minute answer

> "Think of two people grabbing the last slice of pizza at the same time. A naive system checks 'is the seat free?' for both, gets 'yes' twice, and sells it twice.
>
> I fixed that with a transaction. When a booking starts, I lock the seat's row using SELECT FOR UPDATE. The second request waits at the lock. When it gets in, it reads the fresh data, sees the seat is booked, and gets a 409. The seat update and the booking insert happen together, so it is all or nothing.
>
> As a second layer, the bookings table has a unique column that holds the seat ID only while a booking is confirmed. So even if my code had a bug, the database would refuse a second active booking.
>
> Seat holds last 5 minutes and expire lazily: I check the time whenever a seat is read, so I need no background job. I wrote concurrency tests where 20 users book one seat at once and exactly one wins, and I ran the whole thing with Docker Compose."

<br>

## The problem it solves

- A limited thing (a seat, a ticket, stock) must never be sold twice.
- Real examples: movie tickets, train and bus seats, doctor appointments, hotel rooms, concert tickets, "only 3 left" sales.
- The danger shows up only when requests overlap in time, so it passes simple manual testing.



<br>

## Key words to know

- **Transaction:** a group of steps treated as one unit. All happen, or none do.
- **Commit:** save all the steps of the transaction.
- **Rollback:** undo all the steps of the transaction.
- **Row lock:** while one transaction holds a lock on a row, others who need that row wait.
- **`SELECT ... FOR UPDATE`:** reads a row and locks it until the transaction ends.
- **Race condition:** a bug that appears when two things run at the same moment.
- **Atomic:** happens in one unbreakable step.
- **ACID:** the four promises of a transaction (see below).
- **Unique constraint:** a rule that stops two rows from having the same value in a column.
- **Foreign key:** a column that must point to a real row in another table.
- **Connection pool:** a group of ready database connections that requests borrow and return.
- **Soft delete:** keep the row and mark it (for example `cancelled`) instead of deleting it.
- **Lazy expiry:** do not clean up expired data. Check the time when you read it.


<br>

## ACID 

- **Atomicity:** all steps happen or none do. Example: the seat update and the booking insert are saved together.
- **Consistency:** the database rules are never broken (unique, foreign key, allowed values).
- **Isolation:** transactions running together do not mess up each other. The row lock gives us this.
- **Durability:** once committed, the data stays, even if the server crashes.

<br>

## Isolation levels 

- **Dirty read:** reading data another transaction has not committed yet.
- **Non-repeatable read:** reading the same row twice and getting different values, because someone changed it in between.
- **Phantom read:** running the same query twice and getting new extra rows.
- **Read Uncommitted:** allows all three problems.
- **Read Committed:** stops dirty reads.
- **Repeatable Read:** stops dirty and non-repeatable reads. This is the default in MySQL InnoDB.
- **Serializable:** stops all three, but is the slowest.
- **Why this matters for us:** with a plain SELECT at the default level, two transactions can both read "available". `FOR UPDATE` is a locking read: it waits for the lock and reads the latest committed data, so the second request sees the truth.

<br>

> ## Booking a seat safely
> - **Idea:** lock the seat row, check it, change it, save, and release the lock.
> - **Where the lock lives:** inside a transaction, on one database connection.
> - **Two layers:** the row lock is the main layer. The unique rule on `active_seat_id` is the safety net.

### Steps
- Borrow one connection from the pool.
- Start a transaction.
- Read the seat with `SELECT ... FOR UPDATE`. If another request holds the lock, wait here.
- If the seat does not exist, rollback and reply 404.
- If the seat is booked, or held by someone else and the hold has not expired, rollback and reply 409.
- Otherwise update the seat to `booked`, and insert the booking row.
- Commit, which saves both changes and releases the lock.
- Always give the connection back to the pool, even after an error.

### Code (be able to explain this)
```js
export async function bookSeat(userId, seatId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const seatResult = await connection.query(SEAT_QUERY, [seatId]); // has FOR UPDATE
    const seat = seatResult[0][0];

    if (!seat) {
      await connection.rollback();
      return { ok: false, status: 404, message: "Seat not found" };
    }

    if (seat.status === "booked" || (isHeldByOthers)) {
      await connection.rollback();
      return { ok: false, status: 409, message: "Seat is already booked" };
    }

    await connection.query("UPDATE seats SET status = 'booked' ... WHERE id = ?", [seatId]);
    await connection.query("INSERT INTO bookings (user_id, seat_id, active_seat_id) VALUES (?, ?, ?)",
      [userId, seatId, seatId]);

    await connection.commit();
    return { ok: true };
  } catch (err) {
    await connection.rollback();
    if (err.code === "ER_DUP_ENTRY") {
      return { ok: false, status: 409, message: "Seat is already booked" };
    }
    throw err;
  } finally {
    connection.release();
  }
}
```

### Why each important part exists
- **`pool.getConnection()`:** a transaction and a lock live on one connection. If I used `pool.query` for each step, MySQL could use different connections, and the lock would be lost between steps.
- **`beginTransaction` and `commit`:** the seat update and booking insert become one unit.
- **`FOR UPDATE`:** this is the line that makes the second request wait.
- **`rollback` before every early return:** otherwise the connection goes back to the pool with an open transaction and a held lock.
- **`ER_DUP_ENTRY` in the catch:** the safety net fired. The database refused a second active booking, and we turn it into a normal 409.
- **`finally { connection.release() }`:** if I forget this, the pool (10 connections) runs out after 10 bookings and the whole app freezes.

### Dry run: two users, one seat

| Step | Request A | Request B |
|---|---|---|
| 1 | begins a transaction | begins a transaction |
| 2 | `FOR UPDATE` on the seat: gets the lock, sees `available` | `FOR UPDATE` on the same seat: lock is taken, so B waits |
| 3 | marks the seat `booked`, inserts the booking | still waiting |
| 4 | commits, lock released | B continues and reads fresh data: `booked` |
| 5 | replies **201** | rollback, replies **409** |

### What if the lock was missing?
- A and B both read `available`.
- Both update the seat and both try to insert a booking.
- The second insert hits `UNIQUE (active_seat_id)` and fails with a duplicate error.
- The catch block turns it into 409. The safety net saved us.
- If both the lock and the unique rule were missing, both bookings would succeed. That is a real double booking.

### Time Complexity
- The seat is found by its ID, so the lookup is very fast and does not slow down as more seats are added. The only extra time is waiting for the lock when many people want the same seat.

### Space Complexity
- One booking row per booking. Nothing extra is kept in memory.

<br>

## The two layers of protection

- **Layer 1: row lock.** Requests for the same seat wait in line, so only one decides at a time.
- **Layer 2: `UNIQUE (active_seat_id)`.** The database itself refuses a second confirmed booking for a seat, even if the code is wrong.
- **Why two layers:** code can have bugs, and a database rule cannot be skipped. Using both is called defense in depth.

### The `active_seat_id` trick
- `active_seat_id` holds the seat ID **only while a booking is confirmed**. On cancel it becomes `NULL`.
- MySQL allows many `NULL` values in a unique column, because `NULL` does not equal `NULL`.
- So a seat can have many cancelled bookings in history, but only one confirmed booking at a time.
- **Why not put UNIQUE on `seat_id`?** A cancelled booking would still hold the seat ID, and the seat could never be booked again.

<br>

> ## Holding a seat for 5 minutes
> - **Idea:** reserve the seat for one user for a short time while they pay. After that, it goes back on sale.
> - **Stored in the `seats` table:** status `held`, who holds it, and when the hold ends.

### Steps
- Lock the seat row, the same way as booking.
- If it is booked, reply 409.
- If someone else holds it and the hold has not expired, reply 409.
- If I already hold it, reply success without extending the time.
- Otherwise set status `held`, my user ID, and an end time of "now plus 5 minutes".
- Commit.

### Lazy expiry (a likely question)
- Nothing deletes expired holds. Whenever a seat is read, the code asks: "is the hold time in the past?" If yes, it counts as available.
- In the seat list, a SQL `CASE WHEN` shows an expired hold as `available`.
- **Why lazy:** no background job to fail silently, and the answer is always correct at the moment of reading.
- **Downside:** expired rows stay in the table until the seat is used again. A small cleanup job could tidy them, but only for neatness, not for correctness.

### Other hold decisions
- **MySQL's `NOW()` for every time check:** one clock decides everything. Node's clock and MySQL's clock can disagree by seconds or by timezone.
- **Pressing hold again does not extend the time:** otherwise a user could hold a seat forever.
- **Holding is protected by the same lock:** two people holding one free seat is the same race as double booking.
- **Booking without holding first is allowed.** Holding is only useful when the user needs time to pay.

### Dry run (hold)

| Time | Action | Result |
|---|---|---|
| 0:00 | User 1 holds seat 4 | 200, held for 5 minutes |
| 2:00 | User 2 holds or books seat 4 | 409, held by someone else |
| 3:00 | Anyone lists seats | seat 4 shows `held` |
| 5:01 | Anyone lists seats | seat 4 shows `available` (hold time passed) |
| 6:00 | User 2 books seat 4 | 201 |

<br>

> ## Cancelling a booking
> - **Idea:** mark the booking `cancelled`, clear `active_seat_id`, and free the seat, all in one transaction.
> - **Analogy:** write "CANCELLED" in the ticket register and cross out the seat number. The entry stays for records, and the seat is free to sell again.

### Steps
- Lock the booking row with `FOR UPDATE`.
- If it does not exist, or belongs to someone else, reply 404.
- If it is already cancelled, reply 409.
- Set the booking `status = cancelled` and `active_seat_id = NULL`.
- Set the seat back to `available`.
- Commit.

### Why these choices
- **Transaction:** two tables change, and they must stay consistent. If only one changed, the seat could stay `booked` forever with no active booking.
- **Soft delete:** the row stays for the history page and for records.
- **404 for someone else's booking, not 403:** a 403 would tell an attacker that the booking exists.
- **User ID comes from the token, never from the request body:** a user cannot cancel as someone else.
- **Double click:** the second cancel waits for the lock, then sees `cancelled` and gets 409. The seat is freed exactly once.

<br>

## Login and security

- **Sign up:** the password is hashed with bcrypt before saving. The real password is never stored.
- **bcrypt:** a one-way scramble that is slow on purpose, which makes guessing passwords expensive. A random salt is built into each hash, so two users with the same password get different hashes.
- **Log in:** bcrypt scrambles the typed password the same way and compares. It never unscrambles anything.
- **Same message for wrong email and wrong password:** so attackers cannot find out which emails have accounts.
- **JWT:** a signed ticket holding the user ID. The server checks the signature with a secret and does not store anything.
- **A JWT is readable but not changeable:** anyone can read the payload, so never put secrets in it, but nobody can change it without the secret.
- **`requireLogin` middleware:** reads the `Authorization: Bearer <token>` header, verifies the token, and saves `req.userId`.
- **401 vs 403 vs 404:** 401 means not logged in, 403 means logged in but not allowed, and 404 means not found. I use 404 for other people's bookings.
- **Placeholders (`?`) in SQL:** values are sent separately from the SQL command, which stops SQL injection.
- **Signup uses the UNIQUE email rule:** I insert straight away and handle the duplicate error, instead of "check, then insert". The check-then-insert version has a race: two people could register the same email at the same moment. Same lesson as the seat: let the database decide.

<br>

## Database tables

- **users:** id, name, unique email, password hash
- **shows:** id, title, show time
- **seats:** one row per seat per show. Has status (`available`, `held`, `booked`), who holds it, and when the hold ends. `UNIQUE (show_id, seat_number)` stops duplicate seat names within a show.
- **bookings:** who booked which seat, status (`confirmed` or `cancelled`), and `active_seat_id`
- **ENUM** columns accept only the allowed words, so a typo like "bookd" is impossible.
- **Foreign keys** stop a booking from pointing to a seat or user that does not exist.

<br>

## How a request flows

- Take `POST /seats/5/book`.
- Express runs the route's list in order: `requireLogin`, then the handler.
- `requireLogin` checks the token and sets `req.userId`.
- The handler turns the URL id into a number (400 if it is not a number).
- It calls `bookSeat(userId, seatId)`, which runs the transaction.
- The route turns the result into a reply: 201, 404 or 409.

**Why routes and services are separate:** the route only handles HTTP (read the request, send the reply). The service only handles the database logic. Each file stays small, and the service can be tested on its own.

<br>

## Testing

- Tests use Node's built-in runner (`node --test`), so no extra library.
- Each run creates its own users, a show, and 5 seats with unique names, and deletes them at the end. Real data is never touched.
- Tokens are created directly in the test, so the test does not need the login route.
- Many requests are started together with `Promise.all`, and then results are counted.
- I count results instead of checking who won, because the winner is random.
- I also check the database, not only the API replies.

**The 5 tests**
- 20 users book one seat at once: exactly 1 gets 201, and 19 get 409. The database has exactly 1 confirmed booking.
- One user clicks Book 10 times: only 1 booking is created.
- 20 users hold one seat at once: exactly 1 holds it.
- A held seat cannot be booked by others, but the holder can book it.
- The same booking is cancelled 5 times at once: only one succeeds, and then another user can rebook the seat.

### The "break it on purpose" story (great in interviews)
- I removed `FOR UPDATE`. The test still passed, because the unique rule stopped the extra inserts.
- Then I also dropped the unique index. Now test 1 failed, and several users got 201 for the same seat. I watched a real double booking.
- I restored both protections. That is how I know both layers do their job.

<br>

## Docker

- The `Dockerfile` packs the Node app. `docker-compose.yml` starts the app and MySQL together.
- **`DB_HOST=mysql`:** inside Docker, the host is the **service name**. `localhost` would mean the app container itself.
- **Port 3307 vs 3306:** 3307 is the door for my own computer. Containers talk to each other on 3306.
- **Health check with `depends_on`:** MySQL takes a while to start, so the app waits until MySQL answers. Without it, early requests could hit a database that is not ready.
- **Why `-h 127.0.0.1` in the health check:** on first start, MySQL runs a temporary server that has no network access. Using the network address makes sure "healthy" means the real server is up.
- **`JWT_SECRET=${JWT_SECRET}`:** compose reads the value from my `.env`, so the secret is not written in a file I commit.
- **Copy `package.json` first in the Dockerfile:** Docker reuses saved steps, so `npm install` is skipped on most rebuilds.

<br>

## Real bugs and lessons (best stories)

- **Check-then-act race.** Reading a seat and then updating it leaves a gap where another request can slip in. Fix: lock the row before checking.
- **Forgetting to release the connection.** The pool runs dry after 10 requests. Fix: `release()` in `finally`.
- **Leaving a transaction open on an early return.** The lock stays held. Fix: rollback before returning.
- **Using `pool.query` inside a transaction.** Different connections lose the lock. Fix: one connection from `getConnection()` for the whole transaction.
- **Docker health check.** A check on the socket says "healthy" during first-time setup. Fix: check on `127.0.0.1`.
- **Test cleanup order.** Delete bookings, then seats, then shows, then users. Rows that point to others must go first, or foreign keys refuse.

**How to tell a bug story:** what happened, how you found it, what the cause was, how you fixed it, and what you learned.

<br>

## Honest limits (say these yourself)

- Payments are simulated. There is no real payment flow.
- It was tested on one app server and one database. I have not load tested it, so I do not claim a requests per second number.
- A JWT cannot be cancelled before it expires (no logout list, no refresh tokens).
- There are no admin routes. The demo show and seats come from a seed file.
- Lists are not paginated.
- Expired holds stay in the table until the seat is used again.

<br>

## What I would improve next

- Admin routes to create shows and seats.
- Refresh tokens and a shorter token life.
- Rate limiting on login and booking (my Rate Limiter Service project does exactly this).
- A small cleanup job for expired holds.
- Retry once if MySQL kills a transaction because of a deadlock.
- Pagination for lists.
- A load test, so I can state a real number.
- Idempotency keys for payments, so a retried payment does not charge twice.
- A queue for flash sales with huge traffic.
- A seat-grid page in React.

<br>

## Interview questions and short answers

- **What is double booking, and how do you stop it?**
  - Two requests read the same seat as free and both book it. I stop it with a transaction and a row lock, plus a unique rule as a safety net.
- **What does `SELECT FOR UPDATE` do?**
  - It reads a row and locks it until the transaction ends. Others who need that row wait, and when they get in, they read the latest data.
- **What is a transaction? What is ACID?**
  - A group of steps that all happen or none do. ACID: atomicity, consistency, isolation, durability.
- **Why use a transaction for booking?**
  - The seat update and the booking insert must succeed together. If one fails, both are undone.
- **Why get one connection from the pool?**
  - A transaction and its lock belong to one connection. Separate `pool.query` calls could use different ones.
- **What happens if you forget `release()`?**
  - The pool runs out of connections and the app freezes.
- **Why a unique column `active_seat_id` and not unique `seat_id`?**
  - So cancelled bookings stay in history but do not block rebooking. `NULL` values do not clash in a unique column.
- **Pessimistic vs optimistic locking?**
  - Pessimistic (what I used): lock first, then work. Optimistic: do not lock, but save with a version number and check that nobody changed the row. Pessimistic is simpler and good when clashes are likely, like the last seat. Optimistic is better when clashes are rare.
- **Could you do it without an explicit lock?**
  - Yes. One option is a conditional update: `UPDATE seats SET status='booked' WHERE id=? AND status='available'`, then check how many rows changed. If 1, I won. If 0, someone else did. I used a transaction and a lock because I also insert the booking row in the same all-or-nothing unit, and because it shows the concept clearly.
- **What is a deadlock? Can it happen here?**
  - Two transactions wait for each other forever, and MySQL kills one. My transactions are short and mostly lock one row, so it is unlikely. To be safe, I would retry once on a deadlock error.
- **How do holds expire?**
  - Lazily. I compare the hold time with MySQL's `NOW()` whenever a seat is read. No background job is needed.
- **Why use MySQL's clock instead of Node's?**
  - One clock avoids small differences and timezone problems.
- **Why not extend the hold when the user presses hold again?**
  - They could hold a seat forever.
- **How does login work?**
  - bcrypt compares the typed password with the stored hash. Then I sign a JWT with the user ID and a 1 day expiry.
- **Why the same error for wrong email and wrong password?**
  - So attackers cannot learn which emails exist.
- **Why 404 for someone else's booking?**
  - It does not reveal that the booking exists.
- **How did you test concurrency?**
  - I fire many requests together with `Promise.all`, count the results, and check the database. Each test uses its own seat.
- **What did your "break it" experiment show?**
  - Without the lock, the unique rule still protected me. Without both, I saw a real double booking. So both layers are doing real work.
- **How would it scale to many servers?**
  - The locks live in MySQL, so many app servers can share one database and still be safe. The database becomes the busy part. For flash sales, I would add a queue.
- **What does the test not prove?**
  - It uses one app server and one database, at small scale. It proves the database locking works, not behavior under very high load.
- **How does this connect to your Rate Limiter project?**
  - Both fight race conditions. In the limiter I used Redis atomic commands and Lua scripts. Here I use MySQL transactions and row locks.

---

## What you should be able to do live

- **Draw the booking flow** on paper: request, login check, transaction, lock, check, update and insert, commit.
- **Dry run two users on one seat** step by step.
- **Explain the `active_seat_id` trick** with a small table of rows.
- **Write the booking transaction in pseudo-code:** begin, select for update, check, update, insert, commit, and rollback on error.
- **Explain one bug** from start to finish.

<br>

## Things to avoid saying

- Do not say "it handles thousands of bookings per second". You have not measured it.
- Do not say it is "production ready". Say it is a learning level system built the right way.
- Do not claim you know something you cannot explain. If your resume says "row locking", be ready to explain `FOR UPDATE`.
- Do not hide the limits. Say them first, and it looks mature.
- If you do not know something, say: "I am not sure, but here is how I would find out."


