# Codex Model Guard

작업에 맞는 모델과 추론 강도를 고르세요.

Windows용 Codex의 첫 요청에서 현재 설정을 확인하는 로컬 워크플로입니다. 설정이 맞으면 바로 시작하고, 바꾸려면 채팅 안에서 모델과 추론 강도를 선택합니다. 선택한 설정으로 원래 질문을 같은 채팅에 전송합니다.

설정 확인과 전송 제어에는 AI 추론을 사용하지 않습니다. 모델을 자동 추천하거나 낮추는 기능은 없습니다. 사용자가 고른 설정을 적용합니다.

## 사용

1. 새 채팅에서 첫 질문을 보냅니다.
2. `1. ⭕ 맞습니다` 또는 `2. ❌ 안 맞습니다`를 고르고 `Ctrl+Enter`를 누릅니다.
3. 1번은 현재 설정으로 시작합니다. **첫 확인에서 10초 동안 응답하지 않아도 현재 설정으로 시작합니다.** 2번을 확정하면 모델 → 추론 강도를 고른 뒤 텍스트 원문을 자동 전송합니다.

모델·강도 선택 카드에는 자동 수락이 없습니다. 첫 확인을 취소하거나 작업을 중지하면 자동 시작하지 않습니다. 숫자를 누른 것만으로는 선택이 확정되지 않으므로, 설정을 바꾸려면 10초 안에 `2` → `Ctrl+Enter`를 누르세요.

설정을 바꾸는 경로는 해당 채팅 ID로 로컬 통신하며 마우스나 키보드를 대신 조작하지 않습니다. 선택을 취소했을 때의 입력 복원은 별도의 보호 조건을 갖춘 Windows UI 자동화를 사용합니다.

## 설치

이 저장소를 ZIP으로 받아 **모두 압축 해제**한 뒤 `설치.cmd`를 더블클릭하세요. 배포용 ZIP은 아래 빌드 명령으로 만들 수 있습니다.

설명된 두 훅의 설치와 신뢰에 동의하면 `Y`를 입력하고 Codex에서 새 채팅을 엽니다. 관리자 권한은 필요하지 않습니다. 기존 설정은 백업하며 다른 MCP·훅·권한 설정은 유지합니다.

필수 환경:

- 로그인된 Windows용 Codex 데스크톱 앱
- Node.js 20.11 이상, PowerShell 7, Codex CLI
- MCP 확인 요청을 허용하는 Codex 권한 모드

설치기는 Codex의 로컬 실행 환경에서 실행 파일을 찾습니다. 외부 런타임을 다운로드하거나 Windows 실행 정책을 바꾸지 않습니다. 자세한 설치 범위와 문제 해결은 [먼저 읽기.txt](./먼저%20읽기.txt)를 참고하세요.

## 동작과 제한

- `SessionStart`에서 새 채팅을 표시하고 `UserPromptSubmit`에서 첫 요청만 확인합니다.
- `맞습니다`는 첨부파일을 포함한 원래 요청을 계속합니다.
- 모델·강도 선택 후 자동 재전송은 **텍스트만** 지원합니다. 첨부파일이 있는 요청은 원래 메시지에서 보내야 합니다.
- 모델과 강도 목록은 해당 PC의 Codex CLI에서 조회합니다. 다른 PC의 목록 캐시는 배포하지 않습니다.
- 자동 전송은 Codex 앱 내부의 로컬 통신에 의존합니다. 앱 업데이트로 호환성이 달라질 수 있습니다.
- OpenAI의 공식 확장 프로그램이 아닙니다. macOS·Linux 및 CLI 단독 사용은 지원하지 않습니다.

확인한 버전: 앱 `26.1013.4894.0`, CLI `0.163.0-alpha.10.2`.

## 개발

외부 npm 의존성은 없습니다. Node.js가 PATH에 없다면 아래 `node`를 실행 파일의 전체 경로로 바꿔 실행하세요.

```powershell
node --test tests/test-confirm-first-prompt.mjs tests/test-settings-picker.mjs tests/test-background-submit.mjs
node --test tests/test-portable-installer.mjs
node scripts/build.mjs
```

첫 명령은 확인·선택·중복 전송 방지를 테스트합니다. 두 번째는 Windows 및 Codex CLI가 필요하며 임시 Codex 홈에서 설치·재설치·복원과 실제 런처를 검사합니다. 실제 사용자 설정이나 실행 중인 채팅은 사용하지 않습니다. 테스트는 모델 API를 호출하지 않습니다.

배포 ZIP은 `dist/Codex-Model-Guard-Windows-v5.2.0.zip`에 생성됩니다. `payload/`를 수정했다면 `node scripts/update-manifest.mjs`로 파일 해시를 갱신한 뒤 테스트하고 빌드하세요.

## 파일 구성

| 경로 | 역할 |
| --- | --- |
| `payload/` | 훅, MCP 서버, 모델 조회, 로컬 전송 및 입력 복원 |
| `installer.mjs` | 설정 병합, 백업, 두 훅의 신뢰 등록, 실패 시 복원 |
| `설치.cmd` | Node.js 탐색 및 설치기 실행 |
| `manifest.json` | 배포할 런타임 파일과 SHA-256 |
| `tests/` | 동작 및 격리 설치 테스트 |
| `scripts/` | 해시 갱신과 배포 ZIP 생성 |

로그인 정보, 대화 기록, 실행 로그, 전송 대기 원문, 개인 설정, 모델 목록 캐시는 저장소에 포함하지 않습니다. 기존 설치와의 호환성을 위해 내부 MCP 이름 `first_prompt_confirm`과 설치 폴더 `hooks/first-prompt-confirm`은 유지합니다.

관련 공식 문서: [Hooks](https://learn.chatgpt.com/docs/hooks), [MCP](https://learn.chatgpt.com/docs/extend/mcp).
