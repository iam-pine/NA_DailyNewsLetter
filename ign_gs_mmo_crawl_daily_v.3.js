// 게임 뉴스 크롤링 통합 코드 (KST 기준 24시간 이내 필터링 적용, 타임존 정확도 개선)
import puppeteer from 'puppeteer';
import axios from 'axios';
import https from 'https';
import moment from 'moment-timezone';

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

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const nowKST = moment().tz('Asia/Seoul');

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
      const timeNode = node.querySelector('div.symbol-text');
      const spans = node.querySelectorAll('span.text-small');

      const title = titleNode?.innerText.trim() || '';
      const href = anchor?.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : baseUrl + href;
      const rawTitle = timeNode?.getAttribute('title')?.trim() || '';
      const cleanDateText = rawTitle.replace(/^Updated on:\s*/, '').trim();
      const commentText = spans[1]?.innerText.trim() || '0';

      return {
        title,
        url,
        dateText: cleanDateText,
        comments: parseInt(commentText.replace(/\D/g, '') || '0', 10)
      };
    });
  });

  totalArticleCount += articles.length;

  for (const article of articles) {
    const articleMoment = moment.tz(
      article.dateText,
      'dddd, MMMM D, YYYY h:mma',
      'America/Los_Angeles'
    ).tz('Asia/Seoul');
    const diffHours = nowKST.diff(articleMoment, 'hours');

    if (diffHours <=24 && article.comments >= 0) {
      const formattedDate = articleMoment.format('YYYY-MM-DD HH:mm');
      const tempPage = await browser.newPage();
      let bodyText = '', imageUrl = '';
      try {
        await tempPage.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await tempPage.waitForSelector('.article-body', { timeout: 10000 });
        bodyText = await tempPage.evaluate(() =>
          Array.from(document.querySelectorAll('.article-body p')).map(p => p.innerText.trim()).join('\n')
        );
        imageUrl = await tempPage.evaluate(() =>
          document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''
        );
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
  for (let i = 0; i < 3; i++) {
    const prevHeight = await ignPage.evaluate('document.body.scrollHeight');
    await ignPage.evaluate('window.scrollBy(0, document.body.scrollHeight)');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const newHeight = await ignPage.evaluate('document.body.scrollHeight');
    if (newHeight === prevHeight) break;
  }

  console.log('🧪 IGN 뉴스 DOM 로딩 완료, 기사 목록 추출 시도 중...');
  try {
    await ignPage.waitForSelector('[data-cy="item-details"]', { timeout: 5000 });
  } catch {
    console.warn('⚠️ IGN 기사 카드 로딩 실패');
  }

  const ignArticles = await ignPage.evaluate(() => {
    const cards = document.querySelectorAll('[data-cy="item-details"]');
    return Array.from(cards).map(card => {
      const title = card.querySelector('[data-cy="item-title"]')?.innerText.trim() || '';
      const subtitle = card.querySelector('[data-cy="item-subtitle"]')?.innerText.trim() || '';
      const commentText = card.querySelector('.comment-count')?.innerText.trim() || '0';
      const anchor = card.closest('a.item-body');
      let link = anchor?.getAttribute('href') || '';
      if (link.startsWith('/')) link = 'https://www.ign.com' + link;
      return { title, subtitle, url: link, comments: parseInt(commentText.replace(/\D/g, '') || '0', 10) };
    });
  });

  console.log(`✅ IGN 기사 수: ${ignArticles.length}`);

  for (const article of ignArticles) {
    const tempPage = await browser.newPage();
    let bodyText = '', imageUrl = '', articleMoment;

    try {
      await tempPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      await tempPage.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      try {
        await tempPage.waitForSelector('main', { timeout: 5000 });
      } catch {
        console.warn(`⚠️ IGN main 섹션 로딩 실패: ${article.url}`);
        continue;
      }

      const publishedTime = await tempPage.evaluate(() => {
        return document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || null;
      });

      if (!publishedTime) {
        console.warn(`⚠️ IGN 날짜 정보 없음: ${article.url}`);
        continue;
      }

      articleMoment = moment.parseZone(publishedTime).tz('Asia/Seoul');
      const diffHours = nowKST.diff(articleMoment, 'hours');
      if (diffHours > 24 || article.comments < 0) continue;

      const formattedDate = articleMoment.format('YYYY-MM-DD HH:mm');

      await tempPage.waitForSelector('main', { timeout: 10000 });
      bodyText = await tempPage.evaluate(() =>
        Array.from(document.querySelectorAll('main p')).map(p => p.innerText.trim()).join('\n')
      );
      imageUrl = await tempPage.evaluate(() =>
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''
      );

      const truncated = bodyText.slice(0, 1000);
      totalBodyLength += truncated.length;
      const textBlock = `제목: ${article.title}\n날짜: ${formattedDate}\n댓글수: ${article.comments}\n링크: ${article.url}\n썸네일: ${imageUrl}\n본문:\n${truncated}${bodyText.length > 1300 ? '...' : ''}`;
      articlePayloads.push(textBlock);
      filteredArticleCount++;
    } catch (err) {
      console.error(`❌ IGN 본문 크롤링 실패: ${article.url}`, err.message);
    } finally {
      try {
        await tempPage.close();
      } catch (e) {
        console.warn(`⚠️ IGN tempPage 닫기 실패 (이미 닫혔을 수 있음): ${article.url}`);
      }
    }
  }


  // ---------------- MassivelyOP ----------------
console.log('\n🔎 [MassivelyOP] 크롤링 시작');
const massPage = await browser.newPage();
await massPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
for (let i = 1; i <= maxPage; i++) {
  const url = i === 1 ? 'https://massivelyop.com/category/news/' : `https://massivelyop.com/category/news/page/${i}/`;
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
      const dateText = dateEl?.getAttribute('datetime')?.trim() || '';
      const commentText = commentEl?.innerText.trim() || '0';
      const comments = commentText.match(/\d+/) ? parseInt(commentText, 10) : 0;
      return { title, url, dateText, comments };
    });
  });

  totalArticleCount += extracted.length;

  for (const article of extracted) {
    const articleMoment = moment.parseZone(article.dateText).tz('Asia/Seoul');
    const diffHours = nowKST.diff(articleMoment, 'hours');

    if (diffHours <= 24 && article.comments >= 0) {
      const formattedDate = articleMoment.format('YYYY-MM-DD HH:mm');
      const tempPage = await browser.newPage();
      let bodyText = '', imageUrl = '';
      try {
        await tempPage.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await tempPage.waitForSelector('article', { timeout: 10000 });
        bodyText = await tempPage.evaluate(() =>
          Array.from(document.querySelectorAll('article p')).map(p => p.innerText.trim()).join('\n')
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

  // 정렬 및 전송
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
      'https://hook.us2.make.com/mn7uhf1jvzrchhbtfylcjfbmfav8toxb',
      { articles: finalText },
      { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
    );
    console.log('\n🚀 Webhook 전송 완료!');
  } else {
    console.log('⚠️ 조건에 맞는 기사가 없음.');
  }

  await browser.close();
})();
