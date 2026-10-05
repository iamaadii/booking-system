import { test, before, after } from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";
import pool from "../src/db.js";
import { app } from "../src/app.js";

const runId = Date.now();
const USER_COUNT = 20;

let server;
let baseUrl;
let userIds = [];
let tokens = [];
let showId;
let seatIds = [];

before(async () => {
    server = app.listen(0);
    baseUrl = "http://localhost:" + server.address().port;

    for (let i = 1; i <= USER_COUNT; i++) {
        const result = await pool.query(
            "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
            [
                "Load User " + i,
                "loadtest-" + runId + "-" + i + "@test.local",
                "not-a-real-hash",
            ],
        );
        const userId = result[0].insertId;
        userIds.push(userId);
        tokens.push(
            jwt.sign({ userId: userId }, process.env.JWT_SECRET, { expiresIn: "1h" }),
        );
    }

    const showResult = await pool.query(
        "INSERT INTO shows (title, show_time) VALUES (?, NOW() + INTERVAL 1 DAY)",
        ["TEST SHOW " + runId],
    );
    showId = showResult[0].insertId;

    for (let i = 1; i <= 5; i++) {
        const seatResult = await pool.query(
            "INSERT INTO seats (show_id, seat_number) VALUES (?, ?)",
            [showId, "T" + i],
        );
        seatIds.push(seatResult[0].insertId);
    }
});

after(async () => {
    server.close();

    if (userIds.length > 0) {
        await pool.query("DELETE FROM bookings WHERE user_id IN (?)", [userIds]);
    }
    if (showId) {
        await pool.query("DELETE FROM seats WHERE show_id = ?", [showId]);
        await pool.query("DELETE FROM shows WHERE id = ?", [showId]);
    }
    if (userIds.length > 0) {
        await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }

    await pool.end();
});

async function callApi(method, path, token) {
    const headers = {};
    if (token) {
        headers["Authorization"] = "Bearer " + token;
    }

    const response = await fetch(baseUrl + path, {
        method: method,
        headers: headers,
    });
    const body = await response.json();

    return { status: response.status, body: body };
}

function countStatus(results, wantedStatus) {
    let count = 0;
    for (let i = 0; i < results.length; i++) {
        if (results[i].status === wantedStatus) {
            count = count + 1;
        }
    }
    return count;
}

test("20 users book the same seat at once: exactly 1 wins", async () => {
    const seatId = seatIds[0];
    const requests = [];

    for (let i = 0; i < USER_COUNT; i++) {
        requests.push(callApi("POST", "/seats/" + seatId + "/book", tokens[i]));
    }

    const results = await Promise.all(requests);

    assert.strictEqual(countStatus(results, 201), 1);
    assert.strictEqual(countStatus(results, 409), 19);

    const check = await pool.query(
        "SELECT COUNT(*) AS total FROM bookings WHERE seat_id = ? AND status = 'confirmed'",
        [seatId],
    );
    assert.strictEqual(Number(check[0][0].total), 1);
});

test("one user clicks Book 10 times: only 1 booking is created", async () => {
    const seatId = seatIds[1];
    const requests = [];

    for (let i = 0; i < 10; i++) {
        requests.push(callApi("POST", "/seats/" + seatId + "/book", tokens[0]));
    }

    const results = await Promise.all(requests);

    assert.strictEqual(countStatus(results, 201), 1);
    assert.strictEqual(countStatus(results, 409), 9);
});

test("20 users hold the same seat at once: exactly 1 holds it", async () => {
    const seatId = seatIds[2];
    const requests = [];

    for (let i = 0; i < USER_COUNT; i++) {
        requests.push(callApi("POST", "/seats/" + seatId + "/hold", tokens[i]));
    }

    const results = await Promise.all(requests);

    assert.strictEqual(countStatus(results, 200), 1);
    assert.strictEqual(countStatus(results, 409), 19);
});

test("a held seat cannot be booked by others, but the holder can book it", async () => {
    const seatId = seatIds[3];

    const hold = await callApi("POST", "/seats/" + seatId + "/hold", tokens[0]);
    assert.strictEqual(hold.status, 200);

    const requests = [];
    for (let i = 1; i < USER_COUNT; i++) {
        requests.push(callApi("POST", "/seats/" + seatId + "/book", tokens[i]));
    }
    const results = await Promise.all(requests);
    assert.strictEqual(countStatus(results, 409), 19);

    const holderBooks = await callApi(
        "POST",
        "/seats/" + seatId + "/book",
        tokens[0],
    );
    assert.strictEqual(holderBooks.status, 201);
});

test("cancelling the same booking 5 times at once frees the seat only once", async () => {
    const seatId = seatIds[4];

    const booked = await callApi("POST", "/seats/" + seatId + "/book", tokens[0]);
    assert.strictEqual(booked.status, 201);
    const bookingId = booked.body.bookingId;

    const requests = [];
    for (let i = 0; i < 5; i++) {
        requests.push(callApi("DELETE", "/bookings/" + bookingId, tokens[0]));
    }
    const results = await Promise.all(requests);

    assert.strictEqual(countStatus(results, 200), 1);
    assert.strictEqual(countStatus(results, 409), 4);

    const rebook = await callApi("POST", "/seats/" + seatId + "/book", tokens[1]);
    assert.strictEqual(rebook.status, 201);
});
