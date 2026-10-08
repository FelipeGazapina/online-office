// Prints "pid phys_footprint_bytes lifetime_max_phys_footprint_bytes" for each pid given, the number Activity Monitor shows in its
// Memory column. A pid that is gone, or not ours to read, prints nothing. procs.mjs compiles this once and runs it for every sample.
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    int pid = atoi(argv[i]);
    struct rusage_info_v4 ri;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) == 0)
      printf("%d %llu %llu\n", pid, (unsigned long long)ri.ri_phys_footprint, (unsigned long long)ri.ri_lifetime_max_phys_footprint);
  }
  return 0;
}
