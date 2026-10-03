import { describe, expect, it } from 'vitest';
import { detectPage } from './zhihu-api';

describe('detectPage', () => {
  it('treats answer permalink as answer, not question', () => {
    expect(detectPage('https://www.zhihu.com/question/652244254/answer/351234567')).toEqual({
      type: 'answer',
      id: '351234567',
    });
  });

  it('treats bare question url as question', () => {
    expect(detectPage('https://www.zhihu.com/question/652244254')).toEqual({
      type: 'question',
      id: '652244254',
    });
  });

  it('treats question list sort paths as question', () => {
    expect(detectPage('https://www.zhihu.com/question/652244254/answers/updated')).toEqual({
      type: 'question',
      id: '652244254',
    });
  });
});
