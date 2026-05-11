/* GitHub Pages project pages live at /repo-name/ so production needs
   an absolute base. Dev keeps "/" so localhost works as-is. */
export default ({ mode }) => ({
  base: mode === 'production' ? '/receipt-gen/' : '/',
  build: { outDir: 'dist' }
});
