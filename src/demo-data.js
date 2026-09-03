// "Fill with demo content" for showcases: populates every template section -
// quote, events, principal's message with portrait, and all six article slots
// with photos - using the bundled sample assets. Demo rows are marked with
// is_demo = 1 so they can be removed again without touching anything staff
// actually wrote; a real principal's message for the week is never replaced.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const config = require('./config');
const { generationWeekStart } = require('./appweek');
const { addDays, weekDeadline } = require('./week');

const DEMO_ASSETS = path.join(__dirname, '..', 'assets', 'demo');

function copyAsset(name) {
  const filename = `demo-${crypto.randomBytes(8).toString('hex')}.png`;
  fs.copyFileSync(path.join(DEMO_ASSETS, name), path.join(config.uploadDir, filename));
  return filename;
}

function removeUpload(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(config.uploadDir, filename));
  } catch { /* already gone */ }
}

function hasDemoData() {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 1').get().c > 0 ||
    db.prepare('SELECT COUNT(*) AS c FROM events WHERE is_demo = 1').get().c > 0 ||
    db.prepare('SELECT COUNT(*) AS c FROM principal_messages WHERE is_demo = 1').get().c > 0 ||
    getSetting('masthead_is_demo') === '1'
  );
}

// Removes only rows marked is_demo = 1 (and their photo files). Content
// created by staff is never touched.
function clearDemoData() {
  const photos = db
    .prepare('SELECT p.filename FROM photos p JOIN news n ON n.id = p.news_id WHERE n.is_demo = 1')
    .all();
  for (const p of photos) removeUpload(p.filename);
  db.prepare('DELETE FROM news WHERE is_demo = 1').run(); // photos rows cascade
  db.prepare('DELETE FROM events WHERE is_demo = 1').run();
  for (const pm of db.prepare('SELECT photo FROM principal_messages WHERE is_demo = 1').all()) {
    removeUpload(pm.photo);
  }
  db.prepare('DELETE FROM principal_messages WHERE is_demo = 1').run();
  // Masthead background, but only when the demo fill added it - one a manager
  // uploaded themselves stays.
  if (getSetting('masthead_is_demo') === '1') {
    removeUpload(getSetting('masthead_photo'));
    setSetting('masthead_photo', '');
    setSetting('masthead_photo_mailchimp_url', '');
    setSetting('masthead_is_demo', '');
  }
}

const DEMO_ARTICLES = [
  {
    slot: 'W',
    section: 'whole_school',
    title: 'Key Stage 3 Sports Day Brings the Whole School Together',
    body:
      'Our Key Stage 3 Sports Day was a fantastic celebration of effort, energy and house spirit. Students competed across track and field events on the Big Pitch, cheered on by classmates, teachers and a wonderful crowd of parents.\n\nBeyond the medals, the day was about participation and perseverance - every student took part in at least two events, and the sportsmanship on display made us all proud. Congratulations to Phoenix House, this year’s overall champions!',
    photos: [],
  },
  {
    slot: 'W',
    section: 'whole_school',
    title: 'Inter-School Friendly Tennis Tournament Success',
    body:
      'On Friday, LIONS Academy hosted an Inter-School Friendly Tennis Tournament with the European School, bringing together 24 student participants for an exciting day of competition and sportsmanship.\n\nThe LIONS Academy team, which included students from both BIST and BGA, delivered an outstanding performance and emerged as the overall tournament champions.\n\nCongratulations to all participants for their dedication, teamwork, and excellent sportsmanship!',
    photos: ['tennis1.png', 'tennis2.png', 'tennis3.png'],
  },
  {
    slot: 'E',
    section: 'secondary',
    title: 'Maths Chessboard Challenge',
    body:
      'Year 6 put their mathematical thinking to the test with the famous Chessboard Rice Challenge. Starting with just one grain of rice on the first square and doubling the amount on each subsequent square, pupils investigated how quickly numbers can grow.\n\nThe challenge sparked discussion about exponential growth and demonstrated how mathematics can help us understand quantities far beyond what we encounter in everyday life.',
    photos: ['chess1.png'],
  },
  {
    slot: 'D',
    section: 'primary',
    title: 'Foundation Students Bake Traditional Adjarian Khachapuri',
    body:
      'This week, our Foundation classes enjoyed a delightful hands-on cooking activity as they learned how to make traditional Adjarian Khachapuri, one of Georgia’s most beloved dishes.\n\nUsing dough, they carefully shaped their khachapuri into the traditional boat shape before filling it with delicious cheese. The students developed their fine motor skills, creativity, and confidence while working collaboratively with their classmates.',
    photos: ['khachapuri1.png', 'khachapuri2.png'],
  },
  {
    slot: 'Y',
    section: 'co_curricular',
    title: 'Reading Challenge: 1,000 Books and Counting',
    body:
      'Our whole-school Reading Challenge has passed a wonderful milestone - together, primary students have now read over 1,000 books this term!\n\nEvery class keeps a reading tree in their corridor, and it has been lovely to watch the leaves multiply week by week. Special congratulations to Year 3, our most-read class so far. Keep the recommendations coming - the library has restocked all the favourites.',
    photos: [],
  },
  {
    slot: 'X',
    section: 'sixth_form',
    title: 'Duke of Edinburgh Expedition Reaches the Kazbegi Foothills',
    body:
      'Our Duke of Edinburgh Bronze group completed their qualifying expedition this weekend, hiking and camping in the foothills near Stepantsminda.\n\nStudents navigated the full route themselves, carried everything they needed, and cooked their own meals - all in true expedition conditions. The teamwork, resilience and good humour they showed over the two days was outstanding. Well done to all fourteen participants!',
    photos: [],
  },
];

// Fills the current submission week. Existing demo rows are replaced;
// everything staff wrote stays exactly as it is.
function fillDemoData(userId) {
  clearDemoData();
  const weekStart = generationWeekStart();
  const issueDate = weekDeadline(weekStart); // the Friday the issue covers

  const demoEvents = [
    { title: 'Key Stage 3 Sports Day', date: issueDate, time_note: 'All Day', location: 'Big Pitch, Sports Hall' },
    { title: 'Year 7, 8 & 9 Overnight Trips to Borjomi, Racha and Stepantsminda', date: addDays(issueDate, 3), end: addDays(issueDate, 6) },
    { title: 'PCA Meeting', date: addDays(issueDate, 5), time_note: '8:30-10:00am', location: 'BIST Meeting Room' },
    { title: 'Virtual Open Day', date: addDays(issueDate, 6), time_note: '7:00-8:00pm', location: 'Online' },
    { title: "Year 6 Leavers' Picnic", date: addDays(issueDate, 7), time_note: '9:00-12:00pm', location: 'Mziuri Park' },
    { title: 'End of the Year Show - Primary & Secondary', date: addDays(issueDate, 11), time_note: '1:00-2:00pm', location: 'Theatre' },
  ];
  const insertEvent = db.prepare(
    'INSERT INTO events (title, event_date, end_date, time_note, location, created_by, week_start, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  );
  for (const ev of demoEvents) {
    insertEvent.run(ev.title, ev.date, ev.end || null, ev.time_note || null, ev.location || null, userId, weekStart);
  }

  const insertNews = db.prepare(
    "INSERT INTO news (title, body, section, included, slot, review_status, created_by, week_start, is_demo) VALUES (?, ?, ?, 1, ?, 'approved', ?, ?, 1)"
  );
  const insertPhoto = db.prepare("INSERT INTO photos (news_id, filename, original_name, mime) VALUES (?, ?, ?, 'image/png')");
  for (const article of DEMO_ARTICLES) {
    const newsId = insertNews.run(article.title, article.body, article.section, article.slot, userId, weekStart).lastInsertRowid;
    for (const asset of article.photos) {
      insertPhoto.run(newsId, copyAsset(asset), asset);
    }
  }

  // Masthead background behind "THE ROAR" - only when none is set, so a
  // manager's own upload is never replaced.
  if (!getSetting('masthead_photo')) {
    setSetting('masthead_photo', copyAsset('masthead.png'));
    setSetting('masthead_photo_mailchimp_url', '');
    setSetting('masthead_is_demo', '1');
  }

  // The week's principal message is unique - only fill it when the slot is
  // free, so a message the principal really wrote is never overwritten.
  const existingPm = db.prepare('SELECT id FROM principal_messages WHERE week_start = ?').get(weekStart);
  if (!existingPm) {
    db.prepare(
      'INSERT INTO principal_messages (week_start, body, quote, quote_author, created_by, photo, is_demo) VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).run(
      weekStart,
      'Dear Parents,\n\nWhat a wonderful week it has been! From the energy of Sports Day to the concentration of our Duke of Edinburgh expedition, our students have shown everything we hope to see: effort, kindness and a real love of learning.\n\nIn the weeks ahead we have a rich programme of trips, performances and community gatherings, and I look forward to seeing many of you at the PCA meeting and our Virtual Open Day.\n\nThank you for your continued support of our school community.',
      'The future belongs to those who believe in the beauty of their dreams.',
      'Eleanor Roosevelt',
      userId,
      copyAsset('principal.png')
    );
  }

  return { weekStart };
}

module.exports = { fillDemoData, clearDemoData, hasDemoData };
