describe('Plan enforcement URL match', () => {
  test('POST create sale path matches /api/sales only', () => {
    const re = /\/api\/sales\/?$/;
    expect(re.test('/api/sales')).toBe(true);
    expect(re.test('/api/sales/')).toBe(true);
    expect(re.test('/api/sales/returns')).toBe(false);
    expect(re.test('/api/sales/abc')).toBe(false);
  });
});
