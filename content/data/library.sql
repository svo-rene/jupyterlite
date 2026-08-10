-- Example database for the SQL notebook (content/pyodide/sql.ipynb).
-- A tiny children's library: authors, books, members and loans.
-- Rebuild library.db from this file with:
--     sqlite3 library.db < library.sql
-- Identifiers are English on purpose, the data is German.

DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS books;
DROP TABLE IF EXISTS authors;
DROP TABLE IF EXISTS members;

CREATE TABLE authors (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    country TEXT NOT NULL
);

CREATE TABLE books (
    id        INTEGER PRIMARY KEY,
    title     TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES authors(id),
    year      INTEGER NOT NULL,
    genre     TEXT NOT NULL,
    pages     INTEGER NOT NULL,
    age_from  INTEGER NOT NULL,
    copies    INTEGER NOT NULL
);

CREATE TABLE members (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    class     TEXT NOT NULL,
    joined_on TEXT NOT NULL
);

CREATE TABLE loans (
    id          INTEGER PRIMARY KEY,
    book_id     INTEGER NOT NULL REFERENCES books(id),
    member_id   INTEGER NOT NULL REFERENCES members(id),
    borrowed_on TEXT NOT NULL,
    returned_on TEXT          -- NULL means: still borrowed
);

INSERT INTO authors (id, name, country) VALUES
    (1, 'Juna Feldmann',    'Deutschland'),
    (2, 'Bosse Lindqvist',  'Schweden'),
    (3, 'Marek Sobota',     'Polen'),
    (4, 'Ida Wintergrün',   'Österreich'),
    (5, 'Nour Adali',       'Marokko'),
    (6, 'Theo Pappel',      'Deutschland'),
    (7, 'Frida Wellenkamp', 'Deutschland'),
    (8, 'Kasimir Blum',     'Schweiz');

INSERT INTO books (id, title, author_id, year, genre, pages, age_from, copies) VALUES
    ( 1, 'Der Mond macht Pause',             1, 2018, 'Bilderbuch',    32,  4, 3),
    ( 2, 'Paula und das Postamt der Tiere',  1, 2021, 'Vorlesebuch',   96,  5, 2),
    ( 3, 'Mika, der Drache mit Schluckauf',  2, 2015, 'Bilderbuch',    40,  4, 4),
    ( 4, 'Die Bibliothek unter dem Apfelbaum', 4, 2020, 'Abenteuer',  184,  8, 2),
    ( 5, 'Herr Sockenlos verliert den Faden', 6, 2019, 'Vorlesebuch', 112,  6, 1),
    ( 6, 'Emil zählt die Sterne',            3, 2012, 'Vorlesebuch',   88,  6, 2),
    ( 7, 'Das U-Boot im Gartenteich',        6, 2022, 'Abenteuer',    156,  8, 3),
    ( 8, 'Nelli und der Nebelbus',           7, 2023, 'Abenteuer',    204,  9, 2),
    ( 9, 'Wolken zum Frühstück',             5, 2017, 'Bilderbuch',    36,  4, 5),
    (10, 'Der Wal, der Briefe schrieb',      2, 2016, 'Vorlesebuch',  128,  7, 3),
    (11, 'Tante Trudes Teleskop',            4, 2014, 'Sachbuch',      64,  8, 1),
    (12, 'Robbi repariert den Regen',        3, 2021, 'Sachbuch',      72,  7, 2),
    (13, 'Die Straße der schiefen Laternen', 7, 2019, 'Krimi',        212, 10, 2),
    (14, 'Ein Igel im Klassenzimmer',        8, 2013, 'Vorlesebuch',  104,  6, 4),
    (15, 'Lulu und die letzte Wolke',        5, 2024, 'Abenteuer',    168,  9, 3),
    (16, 'Das Geheimnis der Gurkenglas-Bande', 8, 2011, 'Krimi',      196, 10, 1);

INSERT INTO members (id, name, class, joined_on) VALUES
    (1, 'Anni Kollberg',   '3a', '2024-09-02'),
    (2, 'Yusuf Demir',     '3a', '2024-09-02'),
    (3, 'Lena Brauer',     '4b', '2023-09-04'),
    (4, 'Milan Novak',     '4b', '2023-09-04'),
    (5, 'Sophie Achterle', '5c', '2022-08-29'),
    (6, 'Tomke Jansen',    '5c', '2024-01-15'),
    (7, 'Ravi Chandran',   '3a', '2025-02-10'),
    (8, 'Hanna Wieland',   '4b', '2022-08-29');

INSERT INTO loans (id, book_id, member_id, borrowed_on, returned_on) VALUES
    ( 1,  1, 1, '2025-03-03', '2025-03-17'),
    ( 2,  3, 1, '2025-03-17', '2025-03-28'),
    ( 3,  9, 2, '2025-03-05', '2025-03-19'),
    ( 4,  4, 3, '2025-03-06', '2025-04-02'),
    ( 5, 13, 3, '2025-04-02', '2025-04-21'),
    ( 6,  7, 4, '2025-03-11', '2025-03-25'),
    ( 7,  8, 5, '2025-03-12', '2025-04-01'),
    ( 8, 15, 5, '2025-04-03', '2025-04-24'),
    ( 9, 10, 6, '2025-03-18', '2025-04-08'),
    (10,  2, 7, '2025-03-20', '2025-04-04'),
    (11, 14, 8, '2025-03-24', '2025-04-07'),
    (12,  4, 8, '2025-04-08', '2025-04-29'),
    (13,  1, 3, '2025-05-05', '2025-05-19'),
    (14,  3, 6, '2025-05-06', '2025-05-20'),
    (15,  7, 2, '2025-05-12', '2025-06-02'),
    (16, 13, 5, '2025-05-14', '2025-05-30'),
    (17, 16, 3, '2025-06-02', '2025-06-23'),
    (18,  9, 7, '2025-06-03', '2025-06-16'),
    (19, 15, 4, '2025-06-10', NULL),
    (20,  8, 1, '2025-06-12', NULL),
    (21, 12, 6, '2025-06-15', NULL),
    (22,  5, 8, '2025-06-16', NULL),
    (23, 10, 2, '2025-06-18', NULL),
    (24,  4, 5, '2025-06-20', NULL);
