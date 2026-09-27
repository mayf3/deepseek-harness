// Exercise the production lease identity check while the parent replaces its path.
#define DSH_CLI_CONTROL 1
#define main cliControlMain
#include "../cli/launcher.cpp"
#undef main

int main(int count, char** arguments) {
  if (count != 2) return 2;
  const fs::path path(arguments[1]);
  const Lease lease(path, false);
  if (!lease.correspondsTo(path)) return 3;
  std::cout << "READY\n" << std::flush;
  std::string resume;
  std::getline(std::cin, resume);
  return lease.correspondsTo(path) ? 0 : busyExit;
}
