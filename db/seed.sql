USE booking_db;

INSERT INTO shows (title, show_time) VALUES
  ('Demo Movie Night', '2026-11-01 19:00:00');

INSERT INTO seats (show_id, seat_number) VALUES
  (1, 'A1'), (1, 'A2'), (1, 'A3'), (1, 'A4'), (1, 'A5'),
  (1, 'B1'), (1, 'B2'), (1, 'B3'), (1, 'B4'), (1, 'B5');