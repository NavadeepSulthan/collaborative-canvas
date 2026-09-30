import { expect, test, type Browser, type Page } from '@playwright/test';

/** Each test gets its own tenant so tests can run in parallel without sharing state. */
function uniqueBoard() {
  return { tenant: `e2e-${Math.random().toString(36).slice(2, 10)}`, room: 'board' };
}

/** A fresh browser context is a separate user: own storage, IndexedDB and WebSocket. */
async function joinAs(
  browser: Browser,
  name: string,
  board: { tenant: string; room: string },
  role: 'editor' | 'viewer' = 'editor',
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/#${board.tenant}/${board.room}`);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Role').selectOption(role);
  await page.getByRole('button', { name: 'Join board' }).click();
  await expect(page.getByTestId('connection-status')).toHaveText(/Live/);
  return page;
}

async function drawShape(page: Page, tool: 'Rectangle' | 'Ellipse', x: number, y: number) {
  await page.getByRole('radio', { name: tool }).click();
  const box = (await page.getByTestId('board').boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 120, box.y + y + 80, { steps: 5 });
  await page.mouse.up();
}

test('edits and presence propagate between users in real time', async ({ browser }) => {
  const board = uniqueBoard();
  const alice = await joinAs(browser, 'Alice', board);
  const bob = await joinAs(browser, 'Bob', board);

  await expect(alice.getByTestId('presence')).toContainText('2 online');
  await drawShape(alice, 'Rectangle', 200, 200);

  await expect(alice.getByTestId('shape-count')).toHaveText('1 shape');
  await expect(bob.getByTestId('shape-count')).toHaveText('1 shape');
});

test('edits made offline are kept locally and merge on reconnect', async ({ browser }) => {
  const board = uniqueBoard();
  const alice = await joinAs(browser, 'Alice', board);
  const bob = await joinAs(browser, 'Bob', board);

  await alice.getByText('Dev tools').click();
  await alice.getByLabel('Simulate offline').check();
  await expect(alice.getByTestId('connection-status')).toHaveText(/Offline/);

  await drawShape(alice, 'Ellipse', 300, 300);
  await drawShape(bob, 'Rectangle', 100, 100);
  await expect(alice.getByTestId('shape-count')).toHaveText('1 shape');
  await expect(bob.getByTestId('shape-count')).toHaveText('1 shape');

  await alice.getByLabel('Simulate offline').uncheck();
  await expect(alice.getByTestId('connection-status')).toHaveText(/Live/);
  await expect(alice.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(bob.getByTestId('shape-count')).toHaveText('2 shapes');
});

test('viewers can watch but not edit', async ({ browser }) => {
  const board = uniqueBoard();
  const editor = await joinAs(browser, 'Editor', board);
  const viewer = await joinAs(browser, 'Viewer', board, 'viewer');

  await expect(viewer.getByRole('radio', { name: 'Rectangle' })).toBeDisabled();
  await drawShape(editor, 'Rectangle', 150, 150);
  await expect(viewer.getByTestId('shape-count')).toHaveText('1 shape');
});

test('boards in different tenants are isolated', async ({ browser }) => {
  const board = uniqueBoard();
  const acme = await joinAs(browser, 'Acme', board);
  const globex = await joinAs(browser, 'Globex', { tenant: `${board.tenant}-x`, room: board.room });

  await drawShape(acme, 'Rectangle', 150, 150);
  await expect(acme.getByTestId('shape-count')).toHaveText('1 shape');
  await globex.waitForTimeout(500);
  await expect(globex.getByTestId('shape-count')).toHaveText('0 shapes');
});
