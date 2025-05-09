// 게임 뉴스 크롤링 통합 코드 (Gamespot, IGN, MassivelyOP)
const puppeteer = require('puppeteer');
const axios = require('axios');
const https = require('https');
const moment = require('moment-timezone');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function parseGamespotDate(dateText) {
  try {
    const cleaned = dateText
      .replace(/^.*?,\s+/, '')
      .replace(/(\d{1,2})(am|pm)/i, '$1 $2')
      .replace(/pm/i, 'PM')
      .replace(/am/i, 'AM');
    return new Date(cleaned);
  } catch (e) {
    return new Date('invalid');
  }
}

function parseRelativeDateToMoment(text) {
  const now = moment().tz('Asia/Seoul');
  const match = text.toLowerCase().match(/(\d+)([dhm]) ago/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const adjusted = now.clone();
  if (unit === 'd') adjusted.subtract(value, 'days');
  if (unit === 'h') adjusted.subtract(value, 'hours');
  if (unit === 'm') adjusted.subtract(value, 'minutes');
  return adjusted;
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const nowKST = moment().tz('Asia/Seoul');
  const todayStr = nowKST.format('YYYY-MM-DD');
  const yesterdayStr = nowKST.clone().subtract(1, 'day').format('YYYY-MM-DD');

  let articlePayloads = [];
  let totalBodyLength = 0;
  let totalArticleCount = 0;
  let filteredArticleCount = 0;
  const maxPage = 2;

  // ---------------- Gamespot ----------------
  console.log('\n🔎 [Gamespot] 크롤링 시작');
  for (let i = 1; i <= maxPage; i++) {
    const url = i === 1 ? 'https://www.gamespot.com/news/' : `https://www.gamespot.com/news/?page=${i}`;
    console.log(`📄 페이지 이동: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.card-item', { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 1000));

    const articles = await page.evaluate(() => {
      const baseUrl = 'https://www.gamespot.com';
      const nodes = document.querySelectorAll('.card-item');
      return Array.from(nodes).map(node => {
        const anchor = node.querySelector('a.card-item__link');
        const titleNode = node.querySelector('h4.card-item__title');
        const timeNode = node.querySelector('time.text-small');
        const spans = node.querySelectorAll('span.text-small');

        const title = titleNode?.innerText.trim() || '';
        const href = anchor?.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : baseUrl + href;
        const dateText = timeNode?.getAttribute('datetime') || '';
        const commentText = spans[1]?.innerText.trim() || '0';

        return {
          title,
          url,
          dateText,
          comments: parseInt(commentText.replace(/\D/g, '') || '0', 10)
        };
      });
    });

    totalArticleCount += articles.length;

    for (const article of articles) {
      const articleDate = parseGamespotDate(article.dateText);
      const articleMoment = moment(articleDate);
      const articleStr = articleMoment.format('YYYY-MM-DD');

      if ((articleStr === todayStr || articleStr === yesterdayStr) && article.comments >= 0) {
        const formattedDate = articleStr;
        const tempPage = await browser.newPage();
        let bodyText = '', imageUrl = '';
        try {
          await tempPage.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await tempPage.waitForSelector('.article-body', { timeout: 10000 });
          bodyText = await tempPage.evaluate(() => Array.from(document.querySelectorAll('.article-body p')).map(p => p.innerText.trim()).join('\n'));
          imageUrl = await tempPage.evaluate(() => document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '');
        } catch (err) {
          console.error(`❌ Gamespot 본문 크롤링 실패: ${article.url}`, err.message);
        } finally {
          await tempPage.close();
        }
        const truncated = bodyText.slice(0, 1000);
        totalBodyLength += truncated.length;
        const textBlock = `제목: ${article.title}\n날짜: ${formattedDate}\n댓글수: ${article.comments}\n링크: ${article.url}\n썸네일: ${imageUrl}\n본문:\n${truncated}${bodyText.length > 1300 ? '...' : ''}`;
        articlePayloads.push(textBlock);
        filteredArticleCount++;
      }
    }
  }

  // ---------------- IGN ----------------
  const ignPage = await browser.newPage();
  console.log('\n🔎 [IGN] 크롤링 시작');
  await ignPage.goto('https://www.ign.com/news', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 10; i++) {
    const prevHeight = await ignPage.evaluate('document.body.scrollHeight');
    await ignPage.evaluate('window.scrollBy(0, document.body.scrollHeight)');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const newHeight = await ignPage.evaluate('document.body.scrollHeight');
    if (newHeight === prevHeight) break;
  }

  const ignArticles = await ignPage.evaluate(() => {
    const cards = document.querySelectorAll('[data-cy="item-details"]');
    const results = [];
    for (const card of cards) {
      const title = card.querySelector('[data-cy="item-title"]')?.innerText.trim() || '';
      const subtitle = card.querySelector('[data-cy="item-subtitle"]')?.innerText.trim() || '';
      const commentText = card.querySelector('.comment-count')?.innerText.trim() || '0';
      const anchor = card.closest('a.item-body');
      let link = anchor?.getAttribute('href') || '';
      if (link.startsWith('/')) link = 'https://www.ign.com' + link;
      results.push({ title, subtitle, url: link, comments: parseInt(commentText.replace(/\D/g, '') || '0', 10) });
    }
    return results;
  });

  const ignFiltered = ignArticles.filter(a => {
    const momentDate = parseRelativeDateToMoment(a.subtitle.split(' - ')[0]);
    if (!momentDate) return false;
    const dateStr = momentDate.format('YYYY-MM-DD');
    return (dateStr === todayStr || dateStr === yesterdayStr) && a.comments >= 0;
  });

  const ignDetails = await Promise.allSettled(
    ignFiltered.map(async (article) => {
      const tempPage = await browser.newPage();
      try {
        await tempPage.goto(article.url, { waitUntil: 'domcontentloaded' });
        await tempPage.waitForSelector('main', { timeout: 10000 });
        const content = await tempPage.evaluate(() => Array.from(document.querySelectorAll('main p')).map(p => p.innerText.trim()).join('\n'));
        const imageUrl = await tempPage.evaluate(() => document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '');
        await tempPage.close();
        const truncated = content.slice(0, 1000);
        return { ...article, content: truncated, fullLength: content.length, thumbnail: imageUrl };
      } catch (err) {
        await tempPage.close();
        return { ...article, content: '', error: err.message, thumbnail: '' };
      }
    })
  );

  ignDetails.filter(r => r.status === 'fulfilled').map(r => r.value).forEach(a => {
    const parsedMoment = parseRelativeDateToMoment(a.subtitle.split(' - ')[0]);
    const formattedDate = parsedMoment ? parsedMoment.format('YYYY-MM-DD') : '[날짜 없음]';
    const textBlock = `제목: ${a.title}\n날짜: ${formattedDate}\n댓글수: ${a.comments}\n링크: ${a.url}\n썸네일: ${a.thumbnail}\n본문:\n${a.content}${a.fullLength > 1300 ? '...' : ''}`;
    articlePayloads.push(textBlock);
    filteredArticleCount++;
  });

// ---------------- MassivelyOP ----------------
console.log('\n🔎 [MassivelyOP] 크롤링 시작');

const massPage = await browser.newPage();
await massPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

for (let i = 1; i <= maxPage; i++) {
  const url = i === 1
    ? 'https://massivelyop.com/category/news/'
    : `https://massivelyop.com/category/news/page/${i}/`;

  console.log(`📄 페이지 이동: ${url}`);
  await massPage.goto(url, { waitUntil: 'domcontentloaded' });
  await massPage.waitForSelector('div.td-module-meta-info time', { timeout: 15000 });

  const extracted = await massPage.evaluate(() => {
    const articles = document.querySelectorAll('div.td_module_16');
    return Array.from(articles).map(box => {
      const titleEl = box.querySelector('h3.entry-title a');
      const dateEl = box.querySelector('time.entry-date');
      const commentEl = box.querySelector('span.td-module-comments a');

      const title = titleEl?.innerText.trim() || '';
      const url = titleEl?.href || '';
      const dateText = dateEl?.getAttribute('datetime') || '';
      const commentText = commentEl?.innerText.trim() || '0';
      const comments = commentText.match(/\d+/) ? parseInt(commentText, 10) : 0;

      return { title, url, dateText, comments };
    });
  });

  totalArticleCount += extracted.length;

  for (const article of extracted) {
    const articleMoment = moment(article.dateText);
    if (!articleMoment.isValid()) continue;

    const articleStr = articleMoment.format('YYYY-MM-DD');
    if ((articleStr === todayStr || articleStr === yesterdayStr) && article.comments >= 0) {
      const formattedDate = articleStr;
      const tempPage = await browser.newPage();
      let bodyText = '', imageUrl = '';

      try {
        await tempPage.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await tempPage.waitForSelector('article', { timeout: 10000 });

        bodyText = await tempPage.evaluate(() =>
          Array.from(document.querySelectorAll('article p'))
            .map(p => p.innerText.trim()).join('\n')
        );

        imageUrl = await tempPage.evaluate(() => {
          const metaImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim();
          if (metaImg) return metaImg;
        
          const articleImg = document.querySelector('article img')?.getAttribute('src')?.trim();
          if (articleImg?.startsWith('http')) return articleImg;
        
          return '';
        });
        
      } catch (err) {
        console.error(`❌ MassivelyOP 본문 크롤링 실패: ${article.url}`, err.message);
      } finally {
        await tempPage.close();
      }

      const truncated = bodyText.slice(0, 1000);
      totalBodyLength += truncated.length;

      const textBlock = `제목: ${article.title}\n날짜: ${formattedDate}\n댓글수: ${article.comments}\n링크: ${article.url}\n썸네일: ${imageUrl}\n본문:\n${truncated}${bodyText.length > 1300 ? '...' : ''}`;
      articlePayloads.push(textBlock);
      filteredArticleCount++;
    }
  }
}

await massPage.close();


  articlePayloads.sort((a, b) => {
    const aMatch = a.match(/댓글수: (\d+)/);
    const bMatch = b.match(/댓글수: (\d+)/);
    const aCount = aMatch ? parseInt(aMatch[1], 10) : 0;
    const bCount = bMatch ? parseInt(bMatch[1], 10) : 0;
    return bCount - aCount;
  });

  const finalText = articlePayloads.join('\n\n---\n\n');
  console.log(`\n📊 총 기사 수: ${totalArticleCount}`);
  console.log(`✅ 필터 통과 기사 수: ${filteredArticleCount}`);
  console.log(`📝 본문 수집 총 글자 수: ${totalBodyLength}`);

  if (articlePayloads.length > 0) {
    await axios.post(
      'https://hook.us2.make.com/e1vaglu6r9fqqetup74n2ez5wf99imir',
      { articles: finalText },
      { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
    );
    console.log('\n🚀 Webhook 전송 완료!');
  } else {
    console.log('⚠️ 조건에 맞는 기사가 없음.');
  }

  await browser.close();
})();
