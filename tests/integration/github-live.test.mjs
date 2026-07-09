if (process.env.RUN_GITHUB_LIVE_TESTS !== '1') {
  console.log('github live tests skipped; set RUN_GITHUB_LIVE_TESTS=1 to run');
  process.exit(0);
}
console.log('GitHub live test hook present. Configure AIWS_TEST_GITHUB_REPO before enabling full live execution.');
