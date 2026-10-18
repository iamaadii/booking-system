# Booking System with Concurrency Handling: Complete Revision Notes


A backend for booking seats (movie show style) that never sells the same seat twice, even when many people click Book at the same moment.


## The problem it solves

A badly built system does this:
1. User A asks "is seat 7 free?" and the answer is yes.
2. User B asks "is seat 7 free?" at the same moment, and the answer is also yes.
3. Both click Book. Both get a booking. The seat is sold twice.

This is a **race condition**. This project stops it with database transactions and row locks, and adds a database rule as a second safety net.

## Real-world use

- Movie and event tickets
- Flight, bus and train seats
- Doctor, salon and meeting slots
- Hotel rooms, restaurant tables
- Flash sales with limited stock

## Tech stack and why each piece is there

| Tech | Why I used it |
|---|---|
| Node.js and Express | The API |
| MySQL | Gives real transactions, row locks and unique rules (ACID) |
| mysql2 connection pool | Many requests share a few database connections |
| JWT | Login without server sessions |
| bcrypt | Stores passwords as hashes |
| Docker and Docker Compose | One command to start MySQL and the app |
| node:test | Tests, including the "many users, one seat" tests |
| Postman | Manual testing |

## Features

- Sign up and log in (JWT, bcrypt)
- View the seats of a show and their status
- Book a seat safely (transaction and row lock)
- Hold a seat for 5 minutes while paying; the hold ends by itself
- Cancel a booking, which frees the seat
- Booking history per user (cancelled bookings are kept)
- Tests that fire many requests at the same seat at once
- One-command run with Docker Compose

## Big picture flow of a booking

1. `POST /seats/:id/book` arrives with the JWT.
2. `requireLogin` checks the token and sets the user.
3. The service gets a connection from the pool and **starts a transaction**.
4. It runs `SELECT ... FOR UPDATE` on that seat row. This **locks** the row.
5. It checks the seat status:
   - already booked: roll back, reply 409
   - held by someone else (and the hold not expired): roll back, reply 409
   - otherwise: continue
6. It updates the seat to `booked` and inserts the booking row.
7. **Commit**, which releases the lock, and reply 201.
8. The connection goes back to the pool (in `finally`).

If two users book the same seat together: the first gets the lock. The second one **waits at the lock**. When the first commits, the second gets in, reads the **fresh** data, sees the seat is booked, and gets a 409.

## Folder and file guide

| File | Job |
|---|---|
| `db/schema.sql` | Creates the tables |
| `db/seed.sql` | Adds one demo show and 10 seats |
| `src/db.js` | The MySQL connection pool |
| `src/app.js` | Express app and routes |
| `src/server.js` | Starts the server |
| `src/routes/authRoutes.js` | Signup, login, me |
| `src/routes/seatRoutes.js` | List seats, hold, book |
| `src/routes/bookingRoutes.js` | My bookings, cancel |
| `src/services/bookingService.js` | `holdSeat`, `bookSeat`, `cancelBooking` (the transaction logic) |
| `src/middleware/requireLogin.js` | Checks the JWT |
| `tests/concurrency.test.js` | The simultaneous request tests |
| `Dockerfile` and `docker-compose.yml` | MySQL (with health check) plus the app |

## Database

- **users:** id, name, unique email, password hash
- **shows:** id, title, show time
- **seats:** one row per seat per show. Columns include status (`available`, `held`, `booked`), `held_by`, `hold_expires_at`
- **bookings:** id, user id, seat id, status (`confirmed`, `cancelled`), and `active_seat_id`

Relations: a user makes many bookings, a show contains many seats, a seat can have many bookings over time (only one active).

## Two layers of protection against double booking

1. **Row lock (main layer):** `SELECT ... FOR UPDATE` makes requests for the same seat wait in line, one at a time.
2. **Unique rule (safety net):** the `bookings` table has a unique column `active_seat_id`.
   - It holds the seat id while a booking is confirmed.
   - It becomes `NULL` when the booking is cancelled.
   - So the database itself refuses a second active booking for the same seat, even if my code had a bug.
   - A unique column allows many `NULL` values, so a cancelled seat can be booked again.

## What a transaction and a lock mean

- **Transaction:** a group of steps that either all happen or none happen (ACID: Atomicity, Consistency, Isolation, Durability). Here "mark seat booked" and "insert booking" must happen together.
- **Row lock (`FOR UPDATE`):** locks only the selected rows. Other transactions that try to read them for update must wait until the first one commits or rolls back.
- **Why a normal `SELECT` is not enough:** a normal read doesn't lock, so two requests can both read "available".
- **Isolation level:** MySQL's default is REPEATABLE READ. A locking read like `FOR UPDATE` reads the **latest committed** data, which is why the second user sees the seat is booked after waiting.
- **Rollback:** when I refuse (404, 409), I roll back so the lock is released straight away.
- **Connection pool:** `getConnection()` gives me one connection for the whole transaction (all the steps must run on the same connection). `release()` in `finally` makes sure the connection returns even if there is an error. Forgetting it would slowly run out of connections.

## Seat holds

- **Hold:** `POST /seats/:id/hold` sets status `held`, saves who holds it, and saves the time the hold ends (5 minutes from now).
- **Book rules:** a seat can be booked if it is available, **or** its hold has expired, **or** you are the one holding it. Refused if booked, or held by someone else.
- **Lazy expiry:** nothing deletes expired holds. Each time a seat is read, the query asks "has the hold time passed?" If yes, it is treated as available. No background job can fail silently, and the answer is always right at the moment of reading.
- **Time comes from MySQL (`NOW()`), not Node.** The hold time is saved with MySQL's clock and checked with MySQL's clock, so there is only one clock to trust. Mixing Node's clock and MySQL's clock could make holds expire too early or too late because of clock or timezone differences.
- **A detail:** the check `(hold_expires_at IS NOT NULL AND hold_expires_at <= NOW())` returns 1 or 0 from MySQL, so the code compares with `Number(seat.hold_expired) === 1`.
- If the same user holds again while their hold is active, the reply is "You already hold this seat" (a harmless repeat).

## Cancel and history

- **Soft delete:** cancelling does not delete the booking. It sets the booking status to `cancelled`, sets `active_seat_id` to `NULL`, and sets the seat back to available. The history stays.
- Cancelling is done inside a transaction with a lock, so cancelling the same booking 5 times at once frees the seat **only once**.
- **404 for someone else's booking:** it doesn't reveal that the booking exists (403 would leak that).
- `GET /bookings/me` shows only my bookings (the user id comes from the token).

## Auth

- **Signup:** the password is hashed with bcrypt. The unique email rule in the database decides duplicates. The code does not do "check, then insert", because that has a race too: two signups with the same email at the same time could both pass the check. Let the database decide.
- **Login:** the same error message for wrong email and wrong password, so attackers can't find out which emails have accounts.
- **JWT:** the token carries the user id. The user id for every action comes from the **token**, never from the request body (otherwise someone could book as another user).

## Routes

| Method | Route | Login | What it does |
|---|---|---|---|
| GET | /health | No | Server check |
| POST | /auth/signup | No | Create an account |
| POST | /auth/login | No | Get a JWT |
| GET | /auth/me | Yes | Who am I |
| GET | /shows/:id/seats | No | List seats and status |
| POST | /seats/:id/hold | Yes | Hold a seat for 5 minutes |
| POST | /seats/:id/book | Yes | Book a seat |
| GET | /bookings/me | Yes | My booking history |
| DELETE | /bookings/:id | Yes | Cancel my booking |

Common replies: `201` created, `400` bad input, `401` not logged in, `404` not found, `409` seat not available.

## Tests (`tests/concurrency.test.js`)

The tests create their own users, show and seats, and delete them at the end.
- 20 users book the same seat at once: exactly 1 wins, 19 are refused.
- One user clicks Book 10 times at once: only 1 booking is created.
- 20 users hold the same seat at once: exactly 1 gets it.
- A held seat can't be booked by others, but the holder can book it.
- Cancelling the same booking 5 times at once frees the seat only once.

Run with `npm test`. MySQL must be running.

## Run it

- Docker: copy `.env.example` to `.env`, set `JWT_SECRET`, then `docker compose up --build`. The API is at `http://localhost:3000`. Try `GET /shows/1/seats`.
- Without Docker: `docker compose up -d mysql`, `npm install`, copy `.env.example` to `.env` (MySQL is on port 3307 from your computer), `npm run dev`.
- Inside Docker the app reaches MySQL by the service name `mysql` on the inner port 3306. From your own computer it is 127.0.0.1 on port 3307.
- The compose file has a MySQL **health check**, so the app only starts after the database is ready.
- The init scripts (`schema.sql`, `seed.sql`) run only the first time the database volume is created. To rebuild from scratch: `docker compose down -v`.

## Design decisions (decision rules)

- **Transaction with a row lock:** the seat update and the booking insert happen together or not at all, and requests for the same seat wait in line.
- **Unique rule as a safety net:** the database refuses a double booking even if the code is wrong.
- **Lock only the seat row, not the whole table:** other seats stay bookable at full speed.
- **Roll back early on refusal:** the lock is released at once.
- **Lazy hold expiry:** no background job to fail silently.
- **MySQL's `NOW()` for all time checks:** one clock.
- **Soft delete for cancellations:** history is kept, only `active_seat_id` is cleared.
- **Let the database decide uniqueness (signup):** avoids check-then-insert races.
- **Same error for wrong email and wrong password.**
- **404 for someone else's booking.**
- **User id from the token, never from the body.**
- **Release the connection in `finally`.**
- **Docker health check:** the app waits for MySQL.

## Bugs and tricky points

| Problem | Cause | Fix or rule |
|---|---|---|
| Double booking in a naive design | Check and write are separate steps with no lock | Transaction plus `SELECT ... FOR UPDATE` |
| Same user clicking many times | Many requests at once | The lock plus the unique rule give only 1 booking |
| Cancel running twice at once | Two cancels read "confirmed" | Lock the booking row inside a transaction |
| Hold time confusion | Two clocks (Node and MySQL) | Use MySQL `NOW()` for both saving and checking |
| `hold_expired` comparisons | MySQL returns 0 or 1 as numbers or strings | Compare with `Number(...) === 1` |
| Leaking connections | Forgot to release on error | `release()` in `finally` |

## Limitations and future work

- Tested on one app server and one database; not load tested at a large scale.
- Holds are not cleaned from the database until read (fine for correctness, but a cleanup job could tidy old rows).
- No payments. The hold represents the "paying" time.
- No seat-grid UI. A React grid would make the demo easier to see.
- Many seats at once (a group booking) needs a careful lock order to avoid deadlocks. Always lock rows in the same order (for example by seat id).
- High traffic could use a Redis queue or Redis stock counters in front of the database (flash-sale style).

## How to scale it

- Keep the app servers stateless (JWT), so you can run many behind a load balancer.
- The database is the bottleneck for hot seats. Row locks only block people fighting for the same seat.
- Add read replicas for the seat list (reads), but keep booking writes on the primary.
- For huge sales, put a queue in front so requests are served in order.

## Commands to remember

```
docker compose up --build        run MySQL and the app
docker compose up -d mysql       only MySQL
docker compose down -v           delete the database data and start fresh
npm run dev                      start the server (without Docker)
npm test                         run the concurrency tests
```

## 30-second pitch

"I built a seat booking backend that never double books. When two users try to book the same seat at the same moment, I use a MySQL transaction with `SELECT FOR UPDATE`, so the second request waits, then sees the seat is gone and gets a 409. A unique column in the database acts as a second safety net. It also has seat holds that expire lazily using MySQL's clock, soft-deleted cancellations, JWT auth, Docker Compose, and tests that fire 20 simultaneous requests at one seat."

## Interview questions and answers

**What is a race condition? Show it in your project.**
When the result depends on the timing of two operations. Two users read "seat is free" at the same time and both book it.

**How did you prevent double booking?**
A transaction with `SELECT ... FOR UPDATE` on the seat row. The second request waits for the lock, then reads the updated data and is refused. Also a unique `active_seat_id` column as a database-level safety net.

**What does `FOR UPDATE` do?**
It locks the selected rows until the transaction ends. Other transactions that try to lock the same rows wait.

**Why not just check the status in code and then update?**
Between the check and the update, another request can change the row. Check-then-write without a lock is the classic race.

**Why a unique column too? Isn't the lock enough?**
The lock is the main protection. The unique rule protects against bugs in my code, like a forgotten lock in a new route. Defense in depth.

**How does `active_seat_id` allow rebooking after a cancel?**
It stores the seat id while the booking is confirmed and `NULL` after cancelling. A unique index allows many `NULL`s, so only one active booking per seat exists but old cancelled ones don't clash.

**What is ACID?**
Atomicity (all or nothing), Consistency (rules are never broken), Isolation (transactions don't see each other's half-done work), Durability (committed data survives crashes).

**What isolation level does MySQL use by default?**
REPEATABLE READ. Plain reads see a snapshot, but locking reads like `FOR UPDATE` see the latest committed data.

**What is a deadlock and could it happen here?**
Two transactions each hold a lock the other needs. In single-seat booking it can't, because each transaction locks one row. For multi-seat bookings I would always lock rows in the same order (by seat id).

**Why use a connection pool?**
Opening a database connection for every request is slow. A pool reuses a few connections. I must use the same connection for the whole transaction and release it in `finally`.

**How do seat holds expire without a background job?**
Lazy expiry. Every read compares the saved hold end time with `NOW()`. If it's past, the seat is treated as available. Nothing needs to clean it up first.

**Why MySQL's `NOW()` and not Node's `Date`?**
One clock for both writing and checking. Different clocks or timezones between Node and MySQL could expire holds too early or too late.

**What is a soft delete and why use it?**
Marking a record as cancelled instead of removing it. It keeps the booking history and audit trail. Only `active_seat_id` is cleared so the seat can be sold again.

**Why return 404 for someone else's booking?**
403 says "this exists but is not yours", which leaks information. 404 says nothing.

**Why the same error for wrong email and wrong password?**
So attackers can't find out which emails have accounts.

**Why take the user id from the token and not the body?**
The body can be forged. The token is signed, so the id in it can be trusted.

**How did you test concurrency?**
The tests fire 20 simultaneous booking requests with `Promise.all` at one seat and assert exactly 1 success and 19 conflicts. Also repeated clicks by one user, simultaneous holds, and repeated cancels.

**How would you handle 100,000 users for one concert?**
Put a queue or waiting room in front, keep stock counters in Redis for fast rejections, make the booking writes idempotent, add read replicas for the seat list, and keep the transaction short so locks are held for less time.

**What would you improve with more time?**
Payments, a seat map UI, a cleanup job for old holds, group bookings with ordered locks, and load testing.

**What did you learn?**
Correctness under concurrency comes from the database, not from if-statements in code. Locks plus constraints beat hope.
