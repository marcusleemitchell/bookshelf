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
