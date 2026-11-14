/**
 * Realistic upstream payloads (trimmed to the fields Bookshelf reads, plus a
 * few it ignores) for Open Library and Google Books. Book data is public
 * bibliographic metadata, not personal data.
 */

export const OL_ISBN_RESPONSE = {
  'ISBN:9780140328721': {
    url: 'https://openlibrary.org/books/OL7353617M/Fantastic_Mr._Fox',
    key: '/books/OL7353617M',
    title: 'Fantastic Mr. Fox',
    authors: [{ url: 'https://openlibrary.org/authors/OL34184A/Roald_Dahl', name: 'Roald Dahl' }],
    number_of_pages: 96,
    pagination: '96 p. :',
    weight: '3.2 ounces',
    identifiers: {
      goodreads: ['1507552'],
      librarything: ['6446'],
      isbn_10: ['0140328726'],
      isbn_13: ['9780140328721'],
      openlibrary: ['OL7353617M'],
    },
    publishers: [{ name: 'Puffin' }],
    publish_date: 'October 1, 1988',
    subjects: [
      { name: 'Animals', url: 'https://openlibrary.org/subjects/animals' },
      { name: 'Foxes', url: 'https://openlibrary.org/subjects/foxes' },
      { name: 'nyt:children', url: 'https://openlibrary.org/subjects/nyt:children' },
      { name: 'Animals', url: 'https://openlibrary.org/subjects/animals' },
    ],
    cover: {
      small: 'https://covers.openlibrary.org/b/id/8739161-S.jpg',
      medium: 'https://covers.openlibrary.org/b/id/8739161-M.jpg',
      large: 'https://covers.openlibrary.org/b/id/8739161-L.jpg',
    },
  },
};

export const GOOGLE_ISBN_RESPONSE = {
  kind: 'books#volumes',
  totalItems: 1,
  items: [
    {
      kind: 'books#volume',
      id: 'wrOQLV6xB-wC',
      etag: 'abc',
      volumeInfo: {
        title: 'Fantastic Mr Fox',
        authors: ['Roald Dahl'],
        publisher: 'Penguin UK',
        publishedDate: '2007-08-30',
        description:
          '<p>The Boggis, Bunce and Bean are three very nasty farmers.</p><p>Mr Fox outwits them &amp; survives.<br>The end.</p>',
        industryIdentifiers: [
          { type: 'ISBN_13', identifier: '9780140328721' },
          { type: 'ISBN_10', identifier: '0140328726' },
        ],
        pageCount: 112,
        printType: 'BOOK',
        categories: ['Juvenile Fiction / Animals / General'],
        imageLinks: {
          smallThumbnail:
            'http://books.google.com/books/content?id=wrOQLV6xB-wC&printsec=frontcover&img=1&zoom=5&edge=curl&source=gbs_api',
          thumbnail:
            'http://books.google.com/books/content?id=wrOQLV6xB-wC&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api',
        },
        language: 'en',
      },
    },
  ],
};

export const GOOGLE_EMPTY_RESPONSE = { kind: 'books#volumes', totalItems: 0 };

export const OL_SEARCH_RESPONSE = {
  numFound: 2,
  start: 0,
  numFoundExact: true,
  docs: [
    {
      key: '/works/OL893415W',
      title: 'Dune',
      author_name: ['Frank Herbert'],
      first_publish_year: 1965,
      isbn: ['0441172717', '9780441172719', 'not-an-isbn'],
      cover_i: 11481354,
      number_of_pages_median: 604,
      publisher: ['Ace Books', 'Chilton Books'],
      language: ['eng', 'spa'],
      subject: ['Science fiction', 'Dune (Imaginary place)', 'Fiction, science fiction, general'],
    },
    {
      key: '/works/OL893416W',
      title: 'Dune Messiah',
      subtitle: 'Book two',
      author_name: ['Frank Herbert'],
    },
    { key: '/works/broken' },
  ],
};

export const OL_SEARCH_EMPTY = { numFound: 0, start: 0, docs: [] };

export const GOOGLE_SEARCH_RESPONSE = {
  kind: 'books#volumes',
  totalItems: 1,
  items: [
    {
      id: 'B1hSG45JCX4C',
      volumeInfo: {
        title: 'The Left Hand of Darkness',
        authors: ['Ursula K. Le Guin'],
        publishedDate: '1969',
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441478125' }],
        imageLinks: {
          thumbnail:
            'http://books.google.com/books/content?id=B1hSG45JCX4C&printsec=frontcover&img=1&zoom=1&source=gbs_api',
        },
      },
    },
    { id: 'missing-volume-info' },
  ],
};

// --- Open Library edition and work records (`/books/<id>.json`, `/works/<id>.json`) ---
// Trimmed from real responses (14/11/2026). Edition descriptions are often
// typed text objects with source markers; work descriptions can be plain
// strings with CRLF line breaks.

/** Edition record with languages and a work, but no description (Fantastic Mr Fox). */
export const OL_EDITION_FOX = {
  key: '/books/OL7353617M',
  title: 'Fantastic Mr. Fox',
  languages: [{ key: '/languages/eng' }],
  works: [{ key: '/works/OL45804W' }],
  number_of_pages: 96,
  latest_revision: 15,
};

export const OL_WORK_FOX = {
  key: '/works/OL45804W',
  title: 'Fantastic Mr Fox',
  description:
    'The main character of Fantastic Mr. Fox is an extremely clever anthropomorphized fox named Mr. Fox. He lives with his wife and four little foxes.\r\n\r\nFinally tired of being constantly outwitted by Mr. Fox, the farmers attempt to capture and kill him.\r\n\r\n',
  subjects: ['Animals', 'Foxes'],
};

/** jscmd=data record for Pride and Prejudice (Penguin Classics, 2003). */
export const OL_ISBN_PRIDE = {
  'ISBN:9780141439518': {
    url: 'https://openlibrary.org/books/OL37076991M/Pride_and_Prejudice',
    key: '/books/OL37076991M',
    title: 'Pride and Prejudice',
    authors: [{ url: 'https://openlibrary.org/authors/OL21594A/Jane_Austen', name: 'Jane Austen' }],
    number_of_pages: 435,
    identifiers: {
      goodreads: ['60481026'],
      isbn_10: ['0141439513'],
      isbn_13: ['9780141439518'],
      oclc: ['703617314'],
      openlibrary: ['OL37076991M'],
    },
    publishers: [{ name: 'Penguin Books' }],
    publish_date: '2003',
    subjects: [
      { name: 'Fiction, Romance, Historical, Regency', url: 'https://openlibrary.org/subjects/x' },
    ],
    cover: { large: 'https://covers.openlibrary.org/b/id/12645114-L.jpg' },
  },
};

export const OL_EDITION_PRIDE = {
  key: '/books/OL37076991M',
  title: 'Pride and Prejudice',
  description: {
    type: '/type/text',
    value:
      'When Elizabeth Bennet first meets eligible bachelor Fitzwilliam Darcy, she thinks him arrogant and conceited. In the sparkling comedy of manners that follows, Jane Austen shows the folly of judging by first impressions.\n--back cover',
  },
  languages: [{ key: '/languages/eng' }],
  works: [{ key: '/works/OL66554W' }],
};

// --- Open Library search with the best-matching edition (`lang=en`) ---

export const OL_SEARCH_EDITIONS_RESPONSE = {
  numFound: 2,
  start: 0,
  numFoundExact: true,
  docs: [
    {
      key: '/works/OL28804417W',
      title: 'The Last Devil to Die',
      author_name: ['Richard Osman'],
      first_publish_year: 2023,
      // Every edition's ISBNs and languages, in no useful order.
      isbn: ['9786073907040', '6073907040', '9780241512449', '0241512441'],
      language: ['spa', 'eng'],
      publisher: ['Grijalbo', 'Penguin Books, Limited'],
      cover_i: 14421360,
      number_of_pages_median: 422,
      subject: ['Mystery', 'Fiction', 'Crime'],
      editions: {
        numFound: 8,
        start: 0,
        numFoundExact: true,
        docs: [
          {
            key: '/books/OL39958267M',
            title: 'The Last Devil to Die',
            language: ['eng'],
            publisher: ['Penguin Books, Limited'],
            publish_date: ['2023'],
            isbn: ['9780241512449', '0241512441'],
          },
        ],
      },
    },
    {
      key: '/works/OL66554W',
      title: 'Pride and Prejudice',
      author_name: ['Jane Austen'],
      first_publish_year: 1813,
      isbn: ['9781090339799', '1511413182'],
      language: ['ger', 'pol', 'eng'],
      publisher: ['OneOnOne Publishing'],
      cover_i: 14348537,
      number_of_pages_median: 351,
      editions: {
        numFound: 4042,
        start: 0,
        numFoundExact: true,
        // The best English edition is a LibriVox recording without an ISBN.
        docs: [
          {
            key: '/books/OL26394550M',
            title: 'Pride & Prejudice',
            cover_i: 8090214,
            language: ['eng'],
            publisher: ['LibriVox'],
            publish_date: ['2007-11-26'],
          },
        ],
      },
    },
  ],
};
