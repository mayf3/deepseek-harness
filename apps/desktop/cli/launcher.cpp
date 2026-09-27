// Installed CLI admission and terminal forwarding. The control build owns the
// exclusive update lock; the public build only forwards arguments to dsh.
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#endif

namespace fs = std::filesystem;
constexpr int busyExit = 75;

struct Busy : std::runtime_error {
  Busy() : std::runtime_error("Desktop is updating, or a dsh command is still running.") {}
};

fs::path executablePath() {
#ifdef _WIN32
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size()) throw std::runtime_error("Cannot locate the installed dsh launcher.");
  return fs::canonical(fs::path(std::wstring(buffer.data(), length)));
#elif defined(__APPLE__)
  uint32_t length = 0;
  _NSGetExecutablePath(nullptr, &length);
  std::vector<char> buffer(length);
  if (_NSGetExecutablePath(buffer.data(), &length) != 0) throw std::runtime_error("Cannot locate the installed dsh launcher.");
  return fs::canonical(buffer.data());
#else
  return fs::canonical("/proc/self/exe");
#endif
}

struct Installation {
  fs::path application;
  fs::path resources;
  fs::path cli;
  fs::path electron;
  fs::path marker;

  Installation() {
    cli = executablePath().parent_path();
    resources = cli.parent_path().parent_path();
#ifdef __APPLE__
    application = resources.parent_path().parent_path();
    electron = application / "Contents" / "MacOS" / "DeepSeek Harness";
#elif defined(_WIN32)
    application = resources.parent_path();
    electron = application / "DeepSeek Harness.exe";
#else
    application = resources.parent_path();
    electron = application / "DeepSeek Harness";
#endif
    marker = application.parent_path() / (fs::path(".").native() + application.filename().native() + fs::path(".dsh-cli-update").native());
  }
};

std::string readFile(const fs::path& path) {
  std::error_code error;
  const auto status = fs::symlink_status(path, error);
  if (error || !fs::is_regular_file(status)) throw std::runtime_error("Expected an ordinary CLI coordination file.");
  if (fs::file_size(path) > 4096) throw std::runtime_error("CLI coordination file exceeds its size limit.");
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error("Cannot read CLI coordination file.");
  std::string result((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  if (input.bad()) throw std::runtime_error("Cannot read CLI coordination file.");
  return result;
}

bool identifier(const std::string& value) {
  if (value.empty() || value.size() > 128) return false;
  for (const unsigned char character : value) {
    if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9') || character == '.' || character == '-' || character == '+')) return false;
  }
  return true;
}

std::string generation(const Installation& installation) {
  std::string result = readFile(installation.cli / "generation");
  if (result.empty() || result.back() != '\n') throw std::runtime_error("Invalid CLI runtime generation.");
  result.pop_back();
  if (!identifier(result)) throw std::runtime_error("Invalid CLI runtime generation.");
  return result;
}

struct Handoff {
  std::string generation;
  std::string token;
  std::string version;

  std::string serialize() const {
    return "DSH_CLI_UPDATE_1\n" + generation + "\n" + token + "\n" + version + "\n";
  }
};

std::unique_ptr<Handoff> readHandoff(const Installation& installation) {
  std::error_code error;
  const auto status = fs::symlink_status(installation.marker, error);
  if (error == std::errc::no_such_file_or_directory || status.type() == fs::file_type::not_found) return nullptr;
  const auto text = readFile(installation.marker);
  std::vector<std::string> lines;
  size_t start = 0;
  while (start < text.size()) {
    const auto end = text.find('\n', start);
    if (end == std::string::npos) throw std::runtime_error("Invalid Desktop update handoff.");
    lines.push_back(text.substr(start, end - start));
    start = end + 1;
  }
  if (lines.size() != 4 || lines[0] != "DSH_CLI_UPDATE_1"
    || !identifier(lines[1]) || !identifier(lines[2]) || !identifier(lines[3])) {
    throw std::runtime_error("Invalid Desktop update handoff.");
  }
  return std::make_unique<Handoff>(Handoff{lines[1], lines[2], lines[3]});
}

class Lease {
#ifdef _WIN32
  HANDLE handle = INVALID_HANDLE_VALUE;
#else
  int handle = -1;
#endif

public:
  Lease(const fs::path& path, bool exclusive) {
#ifdef _WIN32
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    handle = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      &attributes, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open the installed CLI lease.");
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info) || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
      CloseHandle(handle);
      handle = INVALID_HANDLE_VALUE;
      throw std::runtime_error("Invalid installed CLI lease.");
    }
    OVERLAPPED offset{};
    if (!LockFileEx(handle, LOCKFILE_FAIL_IMMEDIATELY | (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0), 0, 1, 0, &offset)) {
      const auto error = GetLastError();
      CloseHandle(handle);
      handle = INVALID_HANDLE_VALUE;
      if (error == ERROR_LOCK_VIOLATION) throw Busy();
      throw std::runtime_error("Cannot acquire the installed CLI lease.");
    }
#else
    handle = open(path.c_str(), O_RDONLY | O_NOFOLLOW);
    if (handle < 0) throw std::runtime_error("Cannot open the installed CLI lease.");
    struct stat info{};
    if (fstat(handle, &info) != 0 || !S_ISREG(info.st_mode)) {
      close(handle);
      handle = -1;
      throw std::runtime_error("Invalid installed CLI lease.");
    }
    if (flock(handle, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) != 0) {
      const int error = errno;
      close(handle);
      handle = -1;
      if (error == EWOULDBLOCK || error == EAGAIN) throw Busy();
      throw std::runtime_error("Cannot acquire the installed CLI lease.");
    }
    // exec keeps this descriptor, so the CLI process owns its shared lease
    // through signal handling and asynchronous shutdown.
    if (fcntl(handle, F_SETFD, 0) == -1) {
      close(handle);
      handle = -1;
      throw std::runtime_error("Cannot inherit the installed CLI lease.");
    }
#endif
  }
  Lease(const Lease&) = delete;
  Lease& operator=(const Lease&) = delete;
  ~Lease() {
#ifdef _WIN32
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
#else
    if (handle >= 0) close(handle);
#endif
  }
};

#ifdef DSH_CLI_CONTROL
void publishHandoff(const Installation& installation, const Handoff& record) {
  // Reject foreign or malformed entries before replacing the last handoff.
  readHandoff(installation);
  std::random_device random;
  const auto temporary = fs::path(installation.marker.native() + fs::path("." + std::to_string(random()) + ".tmp").native());
  const auto bytes = record.serialize();
#ifdef _WIN32
  HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot prepare Desktop update handoff.");
  DWORD written = 0;
  const bool complete = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
  CloseHandle(file);
  if (!complete || !MoveFileExW(temporary.c_str(), installation.marker.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temporary.c_str());
    throw std::runtime_error("Cannot publish Desktop update handoff.");
  }
#else
  const int file = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
  if (file < 0) throw std::runtime_error("Cannot prepare Desktop update handoff.");
  const auto written = write(file, bytes.data(), bytes.size());
  const bool complete = written >= 0 && static_cast<size_t>(written) == bytes.size();
  const int closed = close(file);
  if (!complete || closed != 0 || rename(temporary.c_str(), installation.marker.c_str()) != 0) {
    unlink(temporary.c_str());
    throw std::runtime_error("Cannot publish Desktop update handoff.");
  }
#endif
}

void cancelHandoff(const Installation& installation, const std::string& token) {
  const auto current = readHandoff(installation);
  if (current && current->token == token && current->generation == generation(installation)) {
    if (!fs::remove(installation.marker)) throw std::runtime_error("Cannot cancel Desktop update handoff.");
  }
}

int control(const std::vector<std::string>& arguments) {
  if (arguments.size() < 2 || !identifier(arguments[1])) throw std::runtime_error("Invalid CLI control request.");
  const Installation installation;
  const Lease lease(installation.cli / "lease", true);
  if (arguments[0] == "cancel" && arguments.size() == 2) {
    cancelHandoff(installation, arguments[1]);
    return 0;
  }
  if (arguments[0] != "hold" || arguments.size() != 3 || !identifier(arguments[2])) {
    throw std::runtime_error("Invalid CLI control request.");
  }
  const Handoff record{generation(installation), arguments[1], arguments[2]};
  readHandoff(installation);
  std::cout << "READY\n" << std::flush;
  bool committed = false;
  std::string command;
  while (std::getline(std::cin, command)) {
    if (command == "HANDOFF" && !committed) {
      publishHandoff(installation, record);
      committed = true;
      std::cout << "COMMITTED\n" << std::flush;
    } else if (command == "CANCEL") {
      if (committed) cancelHandoff(installation, record.token);
      return 0;
    } else {
      throw std::runtime_error("Invalid CLI control command.");
    }
  }
  // EOF after COMMITTED is the GUI-to-installer handoff. Its record blocks the
  // old generation even after the GUI and this lock owner have exited.
  return 0;
}
#else
#ifdef _WIN32
struct WindowsHandle {
  HANDLE value = nullptr;
  explicit WindowsHandle(HANDLE handle = nullptr) : value(handle) {}
  WindowsHandle(const WindowsHandle&) = delete;
  WindowsHandle& operator=(const WindowsHandle&) = delete;
  ~WindowsHandle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};

struct ProcessAttributes {
  std::vector<unsigned char> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ProcessAttributes(HANDLE job) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    storage.resize(size);
    auto candidate = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(candidate, 1, 0, &size)) throw std::runtime_error("Cannot prepare CLI process attributes.");
    list = candidate;
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), nullptr, nullptr)) {
      DeleteProcThreadAttributeList(list);
      list = nullptr;
      throw std::runtime_error("Cannot prepare the CLI process job.");
    }
  }
  ~ProcessAttributes() { if (list) DeleteProcThreadAttributeList(list); }
};

std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const auto character : value) {
    if (character == L'\\') { ++slashes; continue; }
    result.append(slashes * (character == L'\"' ? 2 : 1), L'\\');
    slashes = 0;
    if (character == L'\"') result += L'\\';
    result += character;
  }
  result.append(slashes * 2, L'\\');
  return result + L"\"";
}

BOOL WINAPI terminalControl(DWORD event) {
  // The child shares this console and receives Ctrl-C itself. Keep the wrapper
  // alive until Node reports its own teardown result and exit status.
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

int launch(int count, wchar_t** arguments) {
  const Installation installation;
  const Lease lease(installation.cli / "lease", false);
  const auto pending = readHandoff(installation);
  if (pending && pending->generation == generation(installation)) throw Busy();
  std::vector<std::wstring> child{
    installation.electron.native(), L"--expose-internals",
    (installation.resources / "app.asar" / "dsh" / "node_modules" / "@deepseek-ai" / "dsh-desktop-host" / "lib" / "cli.js").native(),
  };
  for (int index = 1; index < count; ++index) child.emplace_back(arguments[index]);
  std::wstring command;
  for (const auto& argument : child) { if (!command.empty()) command += L' '; command += quote(argument); }
  if (!SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1") || !SetConsoleCtrlHandler(terminalControl, TRUE)) {
    throw std::runtime_error("Cannot prepare the CLI process.");
  }
  WindowsHandle job(CreateJobObjectW(nullptr, nullptr));
  WindowsHandle completion(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1));
  if (!job.value || !completion.value) throw std::runtime_error("Cannot own the CLI process tree.");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT notification{nullptr, completion.value};
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
    || !SetInformationJobObject(job.value, JobObjectAssociateCompletionPortInformation, &notification, sizeof(notification))) {
    throw std::runtime_error("Cannot supervise the CLI process tree.");
  }
  ProcessAttributes attributes(job.value);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.lpAttributeList = attributes.list;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(installation.electron.c_str(), command.data(), nullptr, nullptr, TRUE,
    EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &process)) {
    throw std::runtime_error("Cannot start the installed CLI.");
  }
  CloseHandle(process.hThread);
  const DWORD waited = WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  const bool completed = waited == WAIT_OBJECT_0 && GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hProcess);
  if (!completed) throw std::runtime_error("Cannot read the CLI exit status.");
  // A killed wrapper also closes the job. Normal completion additionally
  // waits until runtime-using descendants have exited before releasing the lease.
  if (!TerminateJobObject(job.value, code)) throw std::runtime_error("Cannot stop the CLI process tree.");
  DWORD message = 0;
  ULONG_PTR key = 0;
  LPOVERLAPPED detail = nullptr;
  while (message != JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) {
    if (!GetQueuedCompletionStatus(completion.value, &message, &key, &detail, INFINITE)) {
      throw std::runtime_error("Cannot await CLI process tree shutdown.");
    }
  }
  return static_cast<int>(code);
}
#else
int launch(int count, char** arguments) {
  const Installation installation;
  const Lease lease(installation.cli / "lease", false);
  const auto pending = readHandoff(installation);
  if (pending && pending->generation == generation(installation)) throw Busy();
  std::vector<std::string> child{
    installation.electron.string(), "--expose-internals",
    (installation.resources / "app.asar" / "dsh" / "node_modules" / "@deepseek-ai" / "dsh-desktop-host" / "lib" / "cli.js").string(),
  };
  for (int index = 1; index < count; ++index) child.emplace_back(arguments[index]);
  std::vector<char*> argv;
  for (auto& argument : child) argv.push_back(argument.data());
  argv.push_back(nullptr);
  if (setenv("ELECTRON_RUN_AS_NODE", "1", 1) != 0) throw std::runtime_error("Cannot prepare the CLI environment.");
  execv(installation.electron.c_str(), argv.data());
  throw std::runtime_error(std::string("Cannot start the installed CLI: ") + std::strerror(errno));
}
#endif
#endif

#if defined(_WIN32) && !defined(DSH_CLI_CONTROL)
int wmain(int count, wchar_t** arguments) {
#else
int main(int count, char** arguments) {
#endif
  try {
#ifdef DSH_CLI_CONTROL
    std::vector<std::string> request;
    for (int index = 1; index < count; ++index) request.emplace_back(arguments[index]);
    return control(request);
#else
    return launch(count, arguments);
#endif
  } catch (const Busy&) {
#ifdef DSH_CLI_CONTROL
    std::cerr << "dsh: finish running dsh commands, then retry the Desktop update.\n";
#else
    std::cerr << "dsh: Desktop update is in progress. Finish the update in Desktop, then retry.\n";
#endif
    return busyExit;
  } catch (const std::exception& error) {
    std::cerr << "dsh: " << error.what() << "\n";
    return 1;
  }
}
