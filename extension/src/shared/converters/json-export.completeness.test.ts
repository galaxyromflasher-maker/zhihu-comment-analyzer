import { describe, expect, it } from 'vitest';
import { buildExportBundle } from './json-export';
import type { CommentCollectionMeta, ExtractedContent, ZhihuComment } from '@/types/zhihu';

function makeContent(): ExtractedContent {
  return {
    id: 'ans1',
    type: 'answer',
    url: 'https://www.zhihu.com/question/1/answer/ans1',
    title: '测试问题',
    author: '作者',
    html: '<p>正文</p>',
    commentCount: 10,
  };
}

function makeMeta(patch: Partial<CommentCollectionMeta> = {}): CommentCollectionMeta {
  return {
    apiDeclaredCount: 10,
    rootPages: 1,
    rootPaginationComplete: true,
    childRequests: 1,
    childCompleted: 1,
    childFailedIds: [],
    childSkippedIds: [],
    childPaginationIncompleteIds: [],
    rateLimited: false,
    ...patch,
  };
}

function nestedReplyTree(): ZhihuComment[] {
  // 知乎楼中楼常见形态：子评声明 child_comment_count>0，但本地 child_comments 为空。
  return [
    {
      id: 'root1',
      content: '一级',
      author: { name: '甲' },
      created_time: 1,
      child_comment_count: 2,
      child_comments: [
        {
          id: 'c1',
          content: '回复甲',
          author: { name: '乙' },
          created_time: 2,
          child_comment_count: 1,
          child_comments: [],
          reply_comment_id: 'root1',
        },
        {
          id: 'c2',
          content: '回复乙',
          author: { name: '丙' },
          created_time: 3,
          child_comment_count: 0,
          child_comments: [],
          reply_comment_id: 'c1',
        },
      ],
    },
  ];
}

describe('buildExportBundle completeness', () => {
  it('keeps soft child_count mismatches as warnings without marking partial', () => {
    const bundle = buildExportBundle({
      content: makeContent(),
      comments: nestedReplyTree(),
      expectedCommentCount: 3,
      collectionMeta: makeMeta(),
    });
    expect(bundle.completeness.status).toBe('complete');
    expect(bundle.completeness.warnings.some((w) => w.includes('声明子评'))).toBe(true);
  });

  it('marks partial only on real collection gaps', () => {
    const bundle = buildExportBundle({
      content: makeContent(),
      comments: nestedReplyTree(),
      expectedCommentCount: 3,
      collectionMeta: makeMeta({
        childFailedIds: ['root1'],
        childCompleted: 0,
      }),
    });
    expect(bundle.completeness.status).toBe('partial');
    expect(bundle.completeness.child_failed_ids).toEqual(['root1']);
  });

  it('marks partial when root request was interrupted', () => {
    const bundle = buildExportBundle({
      content: makeContent(),
      comments: nestedReplyTree(),
      collectionMeta: makeMeta({
        rootPaginationComplete: false,
        rootErrorStatus: 403,
        rateLimited: true,
      }),
    });
    expect(bundle.completeness.status).toBe('partial');
    expect(bundle.completeness.rate_limited).toBe(true);
  });
});
