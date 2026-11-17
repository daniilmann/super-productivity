import { parseAppUriTaskAction, TASK_ACTION_HOSTS } from './parse-app-uri-task-action';

describe('Fork task URI policy: parser', () => {
  it('advertises no supported task action hosts', () => {
    expect([...TASK_ACTION_HOSTS]).toEqual([]);
  });

  ['com.super-productivity.app', 'superproductivity'].forEach((scheme) => {
    ['create-task', 'Create-Task', 'complete-task', 'CoMpLeTe-TaSk'].forEach((host) => {
      [
        '',
        '?title=',
        '?title=Buy%20milk',
        '?title=%20',
        '?title=+',
        '?title=%20Buy%20milk%20',
        '?title=%D0%97%D0%B0%D0%B4%D0%B0%D1%87%D0%B0%20%F0%9F%8C%BF&notes=2%25%20fat%26more&projectId=proj%2F1',
        '/Buy%20milk?notes=private',
      ].forEach((suffix) => {
        it(`rejects ${scheme}://${host}${suffix}`, () => {
          expect(parseAppUriTaskAction(`${scheme}://${host}${suffix}`)).toBeNull();
        });
      });
    });
  });

  [
    '',
    'not a url',
    'com.super-productivity.app://ho st?title=private',
    'com.super-productivity.app://oauth-callback?code=abc&provider=dropbox',
    'com.super-productivity.app://plugin-oauth-callback?code=abc',
    'superproductivity://add-task',
    'superproductivity://today',
    'superproductivity://inbox',
    'superproductivity://task-toggle-start',
    'https://example.com/path?title=Buy%20milk',
  ].forEach((url) => {
    it(`keeps unrelated or malformed input out of task actions: ${url}`, () => {
      expect(parseAppUriTaskAction(url)).toBeNull();
    });
  });
});
